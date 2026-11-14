from typing import Any

import pytest
from django.core.cache import cache

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning import participation_services, team_services
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    AssignmentWork,
)
from code_along.learning.tests.test_assignments import publish, write
from code_along.learning.tests.test_participation import (
    approve_and_consent,
    enroll,
    learner,
    prepared,
    ready_team,
    work_body,
)
from code_along.submissions import services
from code_along.submissions.models import Submission, SubmissionParticipant
from code_along.submissions.tests.test_submissions import candidate, fixture, url

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def set_attempt_policy(teacher: Any, assignment: Assignment, maximum: int) -> None:
    assignment.refresh_from_db()
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {"expected_revision": assignment.revision, "max_attempts": maximum},
        method="patch",
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()


def test_team_version_sequence_101_survives_exact_approved_replacement_roster() -> None:
    source, teacher, assignment = prepared("team")
    set_attempt_policy(teacher, assignment, 100)
    a, first = learner(source, "sequence-owner")
    b, second = learner(source, "sequence-peer")
    team = ready_team(teacher, assignment, [(a, first), (b, second)])
    response = write(
        first, f"/api/v1/assignments/{assignment.id}/works/", work_body(assignment, a)
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    for number in range(1, 101):
        selected = services.prepare(candidate(work, ""), work.id)
        record, created = services.submit(
            a, first.session.session_key, assignment.id, work.id, selected
        )
        assert created and record.subject_attempt_number == number
    assert Submission.objects.count() == 100
    assert set(
        SubmissionParticipant.objects.filter(user=a).values_list(
            "attempt_number", flat=True
        )
    ) == set(range(1, 101))
    for user in (a, b):
        team.refresh_from_db()
        participation = AssignmentParticipation.objects.get(
            assignment=assignment, user=user
        )
        team_services.remove_team_member(
            assignment.created_by,
            teacher.session.session_key,
            assignment.id,
            team.id,
            participation.id,
            expected_team_revision=team.revision,
            expected_participation_revision=participation.revision,
        )
    c, third = learner(source, "replacement-owner")
    d, fourth = learner(source, "replacement-peer")
    for user, client in ((c, third), (d, fourth)):
        participation = enroll(teacher, assignment, user, client)
        team.refresh_from_db()
        team_services.offer_team_member(
            assignment.created_by,
            teacher.session.session_key,
            assignment.id,
            team.id,
            participation_id=participation.id,
            expected_team_revision=team.revision,
            expected_participation_revision=participation.revision,
        )
    approve_and_consent(teacher, assignment, team, [(c, third), (d, fourth)])
    response = write(
        third, f"/api/v1/assignments/{assignment.id}/works/", work_body(assignment, c)
    )
    assert response.status_code == 201, response.content
    fresh = AssignmentWork.objects.get(id=response.json()["id"])
    assert (
        fresh.project_id != work.project_id
        and fresh.assignment_version_id == work.assignment_version_id
    )
    response = write(third, url(assignment, fresh), candidate(fresh, ""))
    assert response.status_code == 201, response.content
    record = Submission.objects.get(id=response.json()["id"])
    assert record.subject_attempt_number == record.assignment_submission_number == 101
    assert set(record.participants.values_list("user_id", flat=True)) == {c.id, d.id}
    assert set(record.participants.values_list("attempt_number", flat=True)) == {1}


def test_individual_attempt_budget_survives_withdraw_reoffer_and_fresh_work() -> None:
    teacher, client, assignment, old = fixture()
    set_attempt_policy(teacher, assignment, 1)
    user = old.created_by
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, user),
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    assert write(client, url(assignment, work), candidate(work, "")).status_code == 201
    participation = AssignmentParticipation.objects.get(
        assignment=assignment, user=user
    )
    participation_services.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="withdraw",
        expected_revision=participation.revision,
    )
    participation.refresh_from_db()
    invitation, _ = participation_services.offer_participation(
        assignment.created_by,
        teacher.session.session_key,
        assignment.id,
        recipient_id=user.id,
        expected_revision=participation.revision,
    )
    participation_services.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="accept",
        expected_revision=invitation.revision,
    )
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, user),
    )
    assert response.status_code == 201, response.content
    fresh = AssignmentWork.objects.get(id=response.json()["id"])
    assert (
        fresh.project_id != work.project_id
        and fresh.assignment_version_id == work.assignment_version_id
    )
    denied = write(client, url(assignment, fresh), candidate(fresh, ""))
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "submission_attempt_limit"
    )
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 1

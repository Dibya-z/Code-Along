import uuid
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from allauth.account.models import EmailAddress
from django.core.cache import cache
from django.db import DatabaseError, connection
from django.test import Client
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning import progress
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    AssignmentWork,
    LearningNotificationStream,
)
from code_along.learning.tests.test_assignments import publish as publish_version
from code_along.learning.tests.test_assignments import ready_assignment_unique, write
from code_along.learning.tests.test_notifications import heads
from code_along.learning.tests.test_participation import (
    enroll,
    learner,
    prepared,
    ready_team,
    work_body,
)
from code_along.projects import services as projects
from code_along.submissions.models import Submission
from code_along.submissions.tests.test_feedback import feedback_fixture, publish, save
from code_along.submissions.tests.test_submissions import candidate, fixture, url
from code_along.workspaces.models import WorkspaceMembership

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def endpoint(assignment: Assignment, *, teacher: bool = False) -> str:
    return f"/api/v1/assignments/{assignment.id}/progress/" + (
        "learners/" if teacher else ""
    )


def read(client: Client, assignment: Assignment, **extra: Any) -> Any:
    return client.get(
        endpoint(assignment),
        {"assignment_version_id": str(assignment.current_version_id), **extra},
        secure=True,
    )


def test_no_offer_is_a_read_only_progress_state_without_stream_authority() -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "not-yet-offered")
    before = (
        AssignmentParticipation.objects.count(),
        LearningNotificationStream.objects.count(),
    )
    response = read(client, assignment)
    assert response.status_code == 200, response.content
    assert response.json() == {
        "assignment_id": str(assignment.id),
        "assignment_version_id": str(assignment.current_version_id),
        "user_id": str(user.id),
        "state": "not_started",
        "eligibility_state": "not_offered",
        "latest_submission": None,
        "latest_assessment": None,
        "can_submit": False,
    }
    assert before == (
        AssignmentParticipation.objects.count(),
        LearningNotificationStream.objects.count(),
    )
    base = f"/api/v1/assignments/{assignment.id}/learning-head/"
    assert client.get(base, {"audience": "participant"}, secure=True).status_code == 404
    assert client.get(base, {"audience": "teaching"}, secure=True).status_code == 404
    head = teacher.get(base, {"audience": "teaching"}, secure=True)
    assert head.status_code == 200 and head.json() == {
        "protocol": "code-along.learning-events",
        "version": 1,
        "scope": "assignment",
        "assignment_id": str(assignment.id),
        "audience": "teaching",
        "head_generation": str(heads(assignment)[None]),
    }
    assert "type" not in head.json()


@pytest.mark.parametrize(
    "query",
    [
        {},
        {"assignment_version_id": str(uuid.uuid4())},
        {"assignment_version_id": "not-a-uuid"},
        {"user_id": str(uuid.uuid4())},
    ],
)
def test_progress_requires_exact_published_version_and_rejects_selector_injection(
    query: dict[str, Any],
) -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "strict-progress")
    if "user_id" in query:
        query = {"assignment_version_id": str(assignment.current_version_id), **query}
    response = client.get(endpoint(assignment), query, secure=True)
    assert response.status_code in {400, 404}, response.content
    assert AssignmentParticipation.objects.count() == 0


def test_historical_state_uses_latest_exact_submission_then_publication_on_that_submission() -> (
    None
):
    teacher, client, assignment, work = fixture()
    started = read(client, assignment).json()
    assert started["state"] == "in_progress" and started["can_submit"]
    first = write(client, url(assignment, work), candidate(work, "print('H1')"))
    assert first.status_code == 201, first.content
    old = Submission.objects.get(id=first.json()["id"])
    assert read(client, assignment).json()["state"] == "submitted"
    assert save(teacher, old, status="complete", comments="").status_code == 200
    assert read(client, assignment).json()["state"] == "submitted"  # draft is private
    first_publication = publish(teacher, old)
    assert first_publication.status_code == 201, first_publication.content
    assert read(client, assignment).json()["state"] == "complete"
    second = write(client, url(assignment, work), candidate(work, "print('H2')"))
    assert second.status_code == 201, second.content
    latest = Submission.objects.get(id=second.json()["id"])
    assert (
        save(
            teacher,
            old,
            revision=2,
            status="needs_changes",
            comments="Old H1 correction",
        ).status_code
        == 200
    )
    assert publish(teacher, old, revision=3).status_code == 201
    state = read(client, assignment).json()
    assert state["state"] == "submitted" and state["latest_assessment"] is None
    assert state["latest_submission"]["id"] == str(latest.id)
    assert (
        state["latest_submission"]["source_manifest_sha256"]
        == latest.source_manifest_sha256
    )
    assert save(teacher, latest).status_code == 200
    current_publication = publish(teacher, latest)
    assert current_publication.status_code == 201, current_publication.content
    state = read(client, assignment).json()
    assert state["state"] == "reviewed"
    assert state["latest_assessment"] == {
        "publication_id": current_publication.json()["id"],
        "assessment_status": "reviewed",
        "assessment_kind": "manual",
        "published_at": current_publication.json()["published_at"],
    }
    assert "comments" not in str(state)


def test_old_work_and_progress_remain_pinned_when_a_new_version_is_published() -> None:
    teacher, client, assignment, work = fixture()
    first_version = assignment.current_version_id
    body = candidate(work)
    assert write(client, url(assignment, work), body).status_code == 201
    assert publish_version(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    assert assignment.current_version_id != first_version
    assert read(client, assignment).json()["state"] == "not_started"
    old = read(client, assignment, assignment_version_id=str(first_version)).json()
    assert old["state"] == "submitted" and old["can_submit"]
    _, foreign_teacher, foreign = ready_assignment_unique()
    assert publish_version(foreign_teacher, foreign).status_code == 201
    foreign.refresh_from_db()
    response = read(
        client, assignment, assignment_version_id=str(foreign.current_version_id)
    )
    assert response.status_code == 404


def test_source_loss_and_advisory_failure_preserve_frozen_history_and_eligibility() -> (
    None
):
    teacher, client, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    assert publish(teacher, record).status_code == 201
    owner, _ = learner(record.project, "new-source-owner-progress")
    projects.transfer_project(
        record.author, record.project_id, owner.id, record.project.metadata_version
    )
    response = read(client, record.assignment)
    assert response.status_code == 200, response.content
    assert response.json()["state"] == "reviewed"
    assert (
        response.json()["eligibility_state"] == "eligible"
        and not response.json()["can_submit"]
    )
    with patch.object(
        progress, "visible_projects", side_effect=DatabaseError("source unavailable")
    ):
        unavailable = read(client, record.assignment)
    assert unavailable.status_code == 200 and unavailable.json() == response.json()


def test_withdrawal_preserves_history_and_workspace_removal_revokes_it() -> None:
    from code_along.learning.participation_services import transition_participation
    from code_along.workspaces.services import update_member

    teacher, client, record = feedback_fixture()
    owner, _ = learner(record.project, "historical-source-owner")
    projects.transfer_project(
        record.author, record.project_id, owner.id, record.project.metadata_version
    )
    part = record.work.participation
    assert part is not None
    transition_participation(
        record.author,
        client.session.session_key,
        record.assignment_id,
        action="withdraw",
        expected_revision=part.revision,
    )
    state = read(client, record.assignment).json()
    assert state["state"] == "submitted" and state["eligibility_state"] == "withdrawn"
    assert not state["can_submit"]
    update_member(
        record.assignment.created_by, record.workspace_id, record.author_id, remove=True
    )
    assert read(client, record.assignment).status_code in {403, 404}
    WorkspaceMembership.objects.filter(
        workspace=record.workspace, user=record.author
    ).update(active=True)
    assert read(client, record.assignment).json()["state"] == "submitted"
    assert read(client, record.assignment).json()["eligibility_state"] == "withdrawn"


def test_deadline_changes_own_advisory_without_any_head_or_history_mutation() -> None:
    teacher, client, assignment, old_work = fixture()
    due = timezone.now() + timedelta(hours=1)
    result = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": assignment.revision,
            "due_at": due.isoformat(),
        },
        method="patch",
    )
    assert result.status_code == 200, result.content
    assignment.refresh_from_db()
    assert publish_version(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    created = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, old_work.created_by),
    )
    assert created.status_code == 201, created.content
    work = AssignmentWork.objects.get(id=created.json()["id"])
    assert write(client, url(assignment, work), candidate(work)).status_code == 201
    before = heads(assignment)
    early = read(client, assignment).json()
    assert early["can_submit"] and early["state"] == "submitted"
    with patch(
        "code_along.learning.progress.timezone.now",
        return_value=due + timedelta(seconds=1),
    ):
        late = read(client, assignment)
    assert late.status_code == 200, late.content
    assert late.json() == {**early, "can_submit": False}
    assert heads(assignment) == before


def test_expired_offer_and_team_consent_change_eligibility_without_assessment_inference() -> (
    None
):
    source, teacher, assignment = prepared("team")
    first, second = (
        learner(source, "progress-team-one"),
        learner(source, "progress-team-two"),
    )
    part = enroll(teacher, assignment, *first)
    assert read(first[1], assignment).json()["eligibility_state"] == "team_pending"
    team = ready_team(teacher, assignment, [first, second])
    assert read(first[1], assignment).json()["eligibility_state"] == "eligible"
    # Consented exact roster remains eligible after the original offer expires.
    AssignmentParticipation.objects.filter(team=team).update(
        team_offer_expires_at=timezone.now() - timedelta(seconds=1)
    )
    state = read(first[1], assignment).json()
    assert state["eligibility_state"] == "eligible" and state["state"] == "not_started"
    assert part.id and team.id


def test_teacher_overview_uses_safe_constant_query_projection_for_one_and_one_hundred_learners() -> (
    None
):
    teacher, client, retained = feedback_fixture()
    assignment, source = retained.assignment, retained.project
    assert (
        save(
            teacher,
            retained,
            status="needs_changes",
            comments="Private comments must not be selected",
        ).status_code
        == 200
    )
    publication = publish(teacher, retained)
    assert publication.status_code == 201, publication.content
    users = [
        User(
            # Keep the genuine retained learner first in both requested pages.
            id=uuid.UUID(int=retained.author_id.int + i + 1),
            email=f"bulk-progress-{i}@example.test",
            display_name=f"Learner {i}",
            password="!",
        )
        for i in range(99)
    ]
    User.objects.bulk_create(users)
    EmailAddress.objects.bulk_create(
        [
            EmailAddress(user=user, email=user.email, primary=True, verified=True)
            for user in users
        ]
    )
    WorkspaceMembership.objects.bulk_create(
        [
            WorkspaceMembership(workspace=source.workspace, user=user, role="learner")
            for user in users
        ]
    )
    records = [
        AssignmentParticipation(
            assignment=assignment,
            workspace=source.workspace,
            user=user,
            invited_by=assignment.created_by,
            invite_expires_at=timezone.now() + timedelta(days=1),
        )
        for user in users
    ]
    AssignmentParticipation.objects.bulk_create(records)
    LearningNotificationStream.objects.bulk_create(
        [
            LearningNotificationStream(
                assignment=assignment,
                workspace=source.workspace,
                participation=record,
                audience_user_id=record.user_id,
            )
            for record in records
        ]
    )
    results, counts = [], []
    with patch.object(
        progress,
        "visible_projects",
        side_effect=AssertionError("Teacher must not query Source"),
    ):
        for limit in (1, 100):
            with CaptureQueriesContext(connection) as captured:
                response = teacher.get(
                    endpoint(assignment, teacher=True),
                    {
                        "assignment_version_id": str(assignment.current_version_id),
                        "limit": limit,
                    },
                    secure=True,
                )
            assert response.status_code == 200, response.content
            results.append(response.json())
            counts.append(len(captured))
            sql = "\n".join(item["sql"].lower() for item in captured.captured_queries)
            for private_table in (
                '"projects_project"',
                '"projects_projectaccess"',
                '"projects_revisionfile"',
                '"submissions_instructorfeedback"',
            ):
                assert private_table not in sql
            assert "comments" not in sql and "initial_source" not in sql
    assert counts[0] == counts[1] and counts[1] < 30
    assert (
        len(results[0]["items"]) == 1
        and len(results[1]["items"]) == results[1]["count"] == 100
    )
    assert {item["user"]["id"] for item in results[1]["items"]} == {
        str(user.id) for user in [*users, retained.author]
    }
    assert results[0]["items"][0] == results[1]["items"][0]
    assert results[0]["items"][0]["latest_submission"]["id"] == str(retained.id)
    assert (
        results[0]["items"][0]["latest_assessment"]["publication_id"]
        == publication.json()["id"]
    )
    assert results[0]["items"][0]["state"] == "needs_changes"
    assert all(
        item["eligibility_state"] == "invited" and item["state"] == "not_started"
        for item in results[1]["items"][1:]
    )
    assert "can_submit" not in str(results) and "@example.test" not in str(results)


def test_teacher_role_loss_during_projection_is_denied_before_return() -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "role-race-progress")
    enroll(teacher, assignment, user, client)
    original = progress._history

    def demote(*args: Any, **kwargs: Any) -> Any:
        result = original(*args, **kwargs)
        WorkspaceMembership.objects.filter(
            workspace=source.workspace, user=assignment.created_by
        ).update(role="learner")
        return result

    with patch.object(progress, "_history", side_effect=demote):
        response = teacher.get(
            endpoint(assignment, teacher=True),
            {"assignment_version_id": str(assignment.current_version_id)},
            secure=True,
        )
    assert response.status_code == 403, response.content
    assert str(user.id) not in response.content.decode()

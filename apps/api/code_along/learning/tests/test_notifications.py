import uuid
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning import participation_services as participation
from code_along.learning import services as assignments
from code_along.learning import team_services
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    AssignmentWork,
    LearningNotificationStream,
)
from code_along.learning.notification_access import (
    authorize_learning_stream,
    read_learning_head,
)
from code_along.learning.notification_types import LearningDenied, stream_group
from code_along.learning.notifications import flush_learning_changes
from code_along.learning.tests.test_assignments import publish as publish_version
from code_along.learning.tests.test_assignments import write
from code_along.learning.tests.test_participation import (
    enroll,
    learner,
    prepared,
    ready_team,
    work_body,
)
from code_along.projects.tests.test_artifact_scope import constraint_name
from code_along.submissions.tests.test_feedback import feedback_fixture, publish, save
from code_along.submissions.tests.test_submissions import candidate, url
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import WorkspaceMembership

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def heads(assignment: Assignment) -> dict[uuid.UUID | None, int]:
    return dict(
        LearningNotificationStream.objects.filter(assignment=assignment).values_list(
            "audience_user_id", "head_generation"
        )
    )


def test_streams_created_only_for_real_assignment_and_lifetime_participation() -> None:
    source, teacher, assignment = prepared()
    assert LearningNotificationStream.objects.count() == 1
    user, client = learner(source, "stream-owner")
    with pytest.raises(LearningDenied):
        authorize_learning_stream(
            client.session.session_key, assignment.id, "participant"
        )
    assert LearningNotificationStream.objects.count() == 1
    record = enroll(teacher, assignment, user, client)
    stream = LearningNotificationStream.objects.get(participation=record)
    assert LearningNotificationStream.objects.count() == 2
    before = heads(assignment)
    # Confirmation of an already accepted transition is a no-op.
    participation.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="accept",
        expected_revision=record.revision - 1,
    )
    assert heads(assignment) == before
    ended = participation.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="withdraw",
        expected_revision=record.revision,
    )
    offered, _ = participation.offer_participation(
        assignment.created_by,
        teacher.session.session_key,
        assignment.id,
        recipient_id=user.id,
        expected_revision=ended.revision,
    )
    assert (
        offered.id == record.id
        and LearningNotificationStream.objects.get(participation=record).id == stream.id
    )
    assert LearningNotificationStream.objects.count() == 2


def test_actual_own_recipient_and_current_teacher_authority_without_source_queries() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "head-reader")
    enroll(teacher, assignment, user, client)
    with CaptureQueriesContext(connection) as queries:
        teaching = read_learning_head(
            teacher.session.session_key, assignment.id, "teaching"
        )
        recipient = read_learning_head(
            client.session.session_key,
            assignment.id,
            "participant",
            expected_user_id=user.id,
        )
    assert stream_group(teaching.access.stream) == f"learning.t.{assignment.id.hex}"
    assert (
        stream_group(recipient.access.stream)
        == f"learning.p.{assignment.id.hex}.{user.id.hex}"
    )
    assert not any(
        '"projects_project"' in item["sql"] or '"projects_projectaccess"' in item["sql"]
        for item in queries.captured_queries
    )
    with pytest.raises(LearningDenied):
        read_learning_head(client.session.session_key, assignment.id, "teaching")
    with pytest.raises(LearningDenied):
        read_learning_head(
            client.session.session_key,
            assignment.id,
            "participant",
            expected_user_id=assignment.created_by_id,
        )
    WorkspaceMembership.objects.filter(workspace=source.workspace, user=user).update(
        active=False
    )
    with pytest.raises(LearningDenied):
        read_learning_head(client.session.session_key, assignment.id, "participant")


def test_private_drafts_and_original_publication_retry_do_not_signal() -> None:
    teacher, client, submission = feedback_fixture()
    assignment = submission.assignment
    before = heads(assignment)
    assert save(teacher, submission).status_code == 200
    assert heads(assignment) == before
    nonce = str(uuid.uuid4())
    result = publish(teacher, submission, nonce=nonce)
    assert result.status_code == 201, result.content
    changed = heads(assignment)
    assert changed == {user: generation + 1 for user, generation in before.items()}
    assert publish(teacher, submission, nonce=nonce).status_code == 200
    assert heads(assignment) == changed
    assert save(teacher, submission, revision=2).status_code == 200
    assert heads(assignment) == changed


def test_move_between_two_rosters_bumps_old_and_new_recipients_once() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"head-team-{number}") for number in range(4)]
    first = ready_team(teacher, assignment, people[:2])
    second = ready_team(teacher, assignment, people[2:])
    user, client = people[0]
    record = AssignmentParticipation.objects.get(assignment=assignment, user=user)
    before = heads(assignment)
    team_services.offer_team_member(
        assignment.created_by,
        teacher.session.session_key,
        assignment.id,
        second.id,
        participation_id=record.id,
        expected_team_revision=second.revision,
        expected_participation_revision=record.revision,
    )
    assert heads(assignment) == {
        identifier: generation + 1 for identifier, generation in before.items()
    }
    assert first.id != second.id and LearningNotificationStream.objects.count() == 5


def test_pending_capture_and_retry_schedule_survive_domain_change_and_broker_outage() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "pending-recipient")
    record = enroll(teacher, assignment, user, client)
    stream = LearningNotificationStream.objects.get(participation=record)
    delayed = timezone.now() + timedelta(seconds=45)
    token = uuid.uuid4()
    LearningNotificationStream.objects.filter(id=stream.id).update(
        claim_generation=stream.head_generation,
        available_at=delayed,
        attempts=5,
        lock_token=token,
        locked_until=delayed,
    )
    with patch(
        "code_along.events.tasks.wake_dispatcher",
        side_effect=RuntimeError("owned broker outage"),
    ):
        participation.transition_participation(
            user,
            client.session.session_key,
            assignment.id,
            action="withdraw",
            expected_revision=record.revision,
        )
    current = LearningNotificationStream.objects.get(id=stream.id)
    assert current.head_generation == stream.head_generation + 1
    assert (
        current.claim_generation == stream.head_generation
        and current.published_generation == 0
    )
    assert (
        current.available_at == delayed
        and current.attempts == 5
        and current.lock_token == token
    )
    assert LearningNotificationStream.objects.count() == 2


def test_removing_an_ended_member_bumps_existing_history_stream_without_reviving_consent() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "ended-member")
    record = enroll(teacher, assignment, user, client)
    participation.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="withdraw",
        expected_revision=record.revision,
    )
    before = heads(assignment)
    workspaces.update_member(
        assignment.created_by, source.workspace_id, user.id, remove=True
    )
    assert heads(assignment) == {
        identifier: generation + 1 for identifier, generation in before.items()
    }
    record.refresh_from_db()
    assert (
        record.state == "withdrawn" and LearningNotificationStream.objects.count() == 2
    )


def test_stream_identity_generations_and_capture_are_database_guarded() -> None:
    source, teacher, assignment = prepared()
    stream = LearningNotificationStream.objects.get(assignment=assignment)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        LearningNotificationStream.objects.filter(id=stream.id).update(
            head_generation=0
        )
    assert constraint_name(error.value) == "learning_stream_monotonic"
    LearningNotificationStream.objects.filter(id=stream.id).update(
        claim_generation=stream.head_generation
    )
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        LearningNotificationStream.objects.filter(id=stream.id).update(
            claim_generation=None
        )
    assert constraint_name(error.value) == "learning_stream_capture_ack"
    with (
        pytest.raises(IntegrityError) as error,
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "DELETE FROM learning_learningnotificationstream WHERE id=%s", [stream.id]
        )
    assert constraint_name(error.value) == "learning_stream_identity_immutable"


def test_new_versions_work_and_submissions_signal_once_but_original_nonces_do_not() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "nonce-head-recipient")
    enroll(teacher, assignment, user, client)
    nonce = uuid.uuid4()
    revision = assignment.revision
    before = heads(assignment)
    first = publish_version(teacher, assignment, nonce=nonce, revision=revision)
    assert first.status_code == 201, first.content
    changed = {user_id: generation + 1 for user_id, generation in before.items()}
    assert heads(assignment) == changed
    assert (
        publish_version(teacher, assignment, nonce=nonce, revision=revision).status_code
        == 200
    )
    assert heads(assignment) == changed
    assignment.refresh_from_db()
    body = work_body(assignment, user)
    path = f"/api/v1/assignments/{assignment.id}/works/"
    first = write(client, path, body)
    assert first.status_code == 201, first.content
    changed = {user_id: generation + 1 for user_id, generation in changed.items()}
    assert heads(assignment) == changed
    assert write(client, path, body).status_code == 200
    assert heads(assignment) == changed
    work = AssignmentWork.objects.get(id=first.json()["id"])
    snapshot = candidate(work)
    assert write(client, url(assignment, work), snapshot).status_code == 201
    changed = {user_id: generation + 1 for user_id, generation in changed.items()}
    assert heads(assignment) == changed
    assert write(client, url(assignment, work), snapshot).status_code == 200
    assert heads(assignment) == changed
    assert LearningNotificationStream.objects.count() == 2


def test_assignment_draft_is_silent_and_archive_restore_signal_all_lifetime_recipients() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "archived-head-recipient")
    record = enroll(teacher, assignment, user, client)
    participation.transition_participation(
        user,
        client.session.session_key,
        assignment.id,
        action="withdraw",
        expected_revision=record.revision,
    )
    before = heads(assignment)
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": assignment.revision,
            "instructions": "An unpublished private change",
        },
        method="patch",
    )
    assert response.status_code == 200, response.content
    assert heads(assignment) == before
    for archived in (True, False):
        assignment.refresh_from_db()
        assignments.archive_assignment(
            assignment.created_by,
            teacher.session.session_key,
            assignment.id,
            expected_revision=assignment.revision,
            archived=archived,
        )
        before = {
            identifier: generation + 1 for identifier, generation in before.items()
        }
        assert heads(assignment) == before


def test_workspace_archive_and_role_changes_have_bounded_deduplicated_audiences() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "workspace-head-recipient")
    enroll(teacher, assignment, user, client)
    before = heads(assignment)
    workspaces.update_workspace(
        assignment.created_by, source.workspace_id, name="Renamed only"
    )
    assert heads(assignment) == before
    for archived in (True, False):
        workspaces.update_workspace(
            assignment.created_by, source.workspace_id, archived=archived
        )
        before = {
            identifier: generation + 1 for identifier, generation in before.items()
        }
        assert heads(assignment) == before
    workspaces.update_member(
        assignment.created_by, source.workspace_id, user.id, role="instructor"
    )
    before[None] += 1
    assert heads(assignment) == before
    workspaces.transfer_ownership(assignment.created_by, source.workspace_id, user.id)
    assert heads(assignment) == before  # Both were already teachers.


def test_confirmed_team_consent_is_silent_and_team_metadata_signals_only_its_roster() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"dedupe-team-{number}") for number in range(3)]
    team = ready_team(teacher, assignment, people[:2])
    enroll(teacher, assignment, *people[2])
    user, client = people[0]
    part = AssignmentParticipation.objects.get(assignment=assignment, user=user)
    before = heads(assignment)
    team_services.consent_team(
        user,
        client.session.session_key,
        assignment.id,
        expected_revision=part.revision - 1,
        team_id=team.id,
        roster_revision=team.roster_revision,
    )
    assert heads(assignment) == before
    team_services.update_team(
        assignment.created_by,
        teacher.session.session_key,
        assignment.id,
        team.id,
        expected_revision=team.revision,
        name="Changed roster label",
    )
    assert heads(assignment) == {
        identifier: generation
        + int(identifier in {None, people[0][0].id, people[1][0].id})
        for identifier, generation in before.items()
    }


def test_failed_final_actual_session_rolls_back_domain_fact_stream_and_head() -> None:
    source, teacher, assignment = prepared()
    before_assignments = set(Assignment.objects.values_list("id", flat=True))
    before_streams = list(LearningNotificationStream.objects.values())
    original = flush_learning_changes

    def expire_after_flush(*args: Any, **kwargs: Any) -> None:
        original(*args, **kwargs)
        Session.objects.filter(session_key=teacher.session.session_key).delete()

    with patch.object(
        assignments, "flush_learning_changes", side_effect=expire_after_flush
    ):
        response = write(
            teacher,
            f"/api/v1/workspaces/{source.workspace_id}/assignments/",
            {"title": "Must roll back"},
        )
    assert response.status_code in {403, 404}, response.content
    assert set(Assignment.objects.values_list("id", flat=True)) == before_assignments
    assert list(LearningNotificationStream.objects.values()) == before_streams
    assert Session.objects.filter(session_key=teacher.session.session_key).exists()


def test_failed_final_recipient_authority_rolls_back_transition_and_bumped_streams() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "rollback-head-recipient")
    record = enroll(teacher, assignment, user, client)
    before = heads(assignment)
    original = flush_learning_changes

    def remove_after_flush(*args: Any, **kwargs: Any) -> None:
        original(*args, **kwargs)
        WorkspaceMembership.objects.filter(
            workspace=source.workspace, user=user
        ).update(active=False)

    with patch.object(
        participation, "flush_learning_changes", side_effect=remove_after_flush
    ):
        response = write(
            client,
            f"/api/v1/assignments/{assignment.id}/participation/withdraw/",
            {"expected_revision": record.revision},
        )
    assert response.status_code in {403, 404}, response.content
    record.refresh_from_db()
    assert record.state == "accepted" and heads(assignment) == before
    assert WorkspaceMembership.objects.get(workspace=source.workspace, user=user).active

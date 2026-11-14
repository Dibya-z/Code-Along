import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from threading import Barrier, Event
from unittest.mock import patch

import pytest
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import transaction
from django.test import Client
from django.utils import timezone

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.models import Assignment, AssignmentWork
from code_along.learning.services import lock_assignment
from code_along.learning.tests.test_assignments import publish as publish_version
from code_along.learning.tests.test_participation import enroll, work_body
from code_along.submissions import feedback_contracts as contract
from code_along.submissions import feedback_services as services
from code_along.submissions.models import (
    FeedbackPublication,
    InstructorFeedback,
    Submission,
    SubmissionAssignmentUsage,
    SubmissionWorkspaceUsage,
)
from code_along.submissions.tests.test_concurrency import thread_call
from code_along.submissions.tests.test_feedback import feedback_fixture, publish, save
from code_along.submissions.tests.test_feedback_integrity import second_submission
from code_along.submissions.tests.test_submissions import candidate, url
from code_along.workspaces.models import Workspace

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def race(callbacks: list[Callable[[], tuple[int, str]]]) -> list[tuple[int, str]]:
    with ThreadPoolExecutor(max_workers=len(callbacks)) as pool:
        futures = [pool.submit(thread_call, callback) for callback in callbacks]
        return [future.result(timeout=20) for future in futures]


def test_two_absent_draft_creations_are_serialized_by_cas() -> None:
    teacher, learner, record = feedback_fixture()
    key = teacher.session.session_key
    barrier = Barrier(2)

    def write(comments: str) -> tuple[int, str]:
        barrier.wait(timeout=10)
        draft = services.save_draft(
            record.assignment.created_by,
            key,
            record.assignment_id,
            record.id,
            expected_revision=0,
            comments=comments,
            assessment_status="reviewed",
        )
        return 200, str(draft.id)

    result = race(
        [partial(write, "one exact draft"), partial(write, "different draft")]
    )
    assert sorted(status for status, _ in result) == [200, 409], result
    assert (409, "feedback_revision_conflict") in result
    assert (
        InstructorFeedback.objects.count() == 1
        and InstructorFeedback.objects.get().revision == 1
    )


@pytest.mark.parametrize("same_nonce", [True, False])
def test_publication_race_confirms_once_or_rejects_stale_cas(same_nonce: bool) -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    key = teacher.session.session_key
    first = uuid.uuid4()
    nonces = [first, first if same_nonce else uuid.uuid4()]
    barrier = Barrier(2)

    def commit(nonce: uuid.UUID) -> tuple[int, str]:
        barrier.wait(timeout=10)
        publication, created = services.publish_feedback(
            record.assignment.created_by,
            key,
            record.assignment_id,
            record.id,
            expected_revision=1,
            client_request_id=nonce,
        )
        return (201 if created else 200), str(publication.id)

    result = race([partial(commit, nonce) for nonce in nonces])
    assert sorted(status for status, _ in result) == (
        [200, 201] if same_nonce else [201, 409]
    ), result
    if same_nonce:
        assert result[0][1] == result[1][1]
    else:
        assert (409, "feedback_revision_conflict") in result
    assert (
        FeedbackPublication.objects.count() == 1
        and InstructorFeedback.objects.get().revision == 2
    )
    charge = FeedbackPublication.objects.get().metadata_bytes
    assert (
        SubmissionAssignmentUsage.objects.get().feedback_metadata_bytes
        == SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes
        == charge
    )


def test_draft_edit_and_publication_cannot_publish_unreviewed_new_revision() -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record, comments="original reviewed draft").status_code == 200
    key = teacher.session.session_key
    barrier = Barrier(2)

    def edit() -> tuple[int, str]:
        barrier.wait(timeout=10)
        draft = services.save_draft(
            record.assignment.created_by,
            key,
            record.assignment_id,
            record.id,
            expected_revision=1,
            comments="concurrent changed draft",
            assessment_status="needs_changes",
        )
        return 200, str(draft.id)

    def commit() -> tuple[int, str]:
        barrier.wait(timeout=10)
        publication, _ = services.publish_feedback(
            record.assignment.created_by,
            key,
            record.assignment_id,
            record.id,
            expected_revision=1,
            client_request_id=uuid.uuid4(),
        )
        return 201, str(publication.id)

    edited, published = race([edit, commit])
    assert sorted([edited[0], published[0]]) in ([200, 409], [201, 409]), (
        edited,
        published,
    )
    assert InstructorFeedback.objects.get().revision == 2
    if published[0] == 201:
        assert FeedbackPublication.objects.get().comments == "original reviewed draft"
    else:
        assert FeedbackPublication.objects.count() == 0
        assert (
            InstructorFeedback.objects.get().draft_comments
            == "concurrent changed draft"
        )


def other_assignment_submission(
    teacher: Client, learner: Client, first: Submission
) -> Submission:
    response = teacher.post(
        f"/api/v1/workspaces/{first.workspace_id}/assignments/",
        {"title": "Independent assignment feedback quota"},
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    assignment = Assignment.objects.get(id=response.json()["id"])
    response = teacher.patch(
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": assignment.revision,
            "starter_revision_id": str(first.assignment_version.starter_revision_id),
            "instructions": "Independent assignment for shared feedback capacity.",
        },
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    published = publish_version(teacher, assignment)
    assert published.status_code == 201, published.content
    assignment.refresh_from_db()
    enroll(teacher, assignment, first.author, learner)
    response = learner.post(
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, first.author),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    response = learner.post(
        url(assignment, work),
        candidate(work, "independent assignment H"),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    record = Submission.objects.get(id=response.json()["id"])
    assert (
        record.assignment_id != first.assignment_id
        and record.workspace_id == first.workspace_id
    )
    return record


@pytest.mark.parametrize("scope", ["ASSIGNMENT", "WORKSPACE"])
def test_concurrent_different_submissions_cannot_overrun_shared_feedback_budget(
    scope: str,
) -> None:
    teacher, learner, first = feedback_fixture()
    second = (
        other_assignment_submission(teacher, learner, first)
        if scope == "WORKSPACE"
        else second_submission(learner, first)
    )
    for record in (first, second):
        assert save(teacher, record, comments="", status="complete").status_code == 200
    now = timezone.now().replace(microsecond=123456)
    with patch(
        "code_along.submissions.feedback_services.timezone.now", return_value=now
    ):
        initial = publish(teacher, first)
        assert initial.status_code == 201, initial.content
        charge = FeedbackPublication.objects.get().metadata_bytes
        assert (
            save(teacher, first, revision=2, comments="", status="complete").status_code
            == 200
        )
        key = teacher.session.session_key
        barrier = Barrier(2)

        def commit(
            assignment_id: uuid.UUID, identifier: uuid.UUID, revision: int
        ) -> tuple[int, str]:
            barrier.wait(timeout=10)
            publication, _ = services.publish_feedback(
                first.assignment.created_by,
                key,
                assignment_id,
                identifier,
                expected_revision=revision,
                client_request_id=uuid.uuid4(),
            )
            return 201, str(publication.id)

        with patch.object(contract, f"MAX_{scope}_FEEDBACK_BYTES", charge * 2):
            result = race(
                [
                    partial(commit, first.assignment_id, first.id, 3),
                    partial(commit, second.assignment_id, second.id, 1),
                ]
            )
        assert sorted(status for status, _ in result) == [201, 409], result
        assert (409, "feedback_metadata_capacity") in result
        assert FeedbackPublication.objects.count() == 2
        assignment_total = sum(
            SubmissionAssignmentUsage.objects.values_list(
                "feedback_metadata_bytes", flat=True
            )
        )
        assert assignment_total == charge * 2
        assert (
            SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes
            == assignment_total
        )
        assert (
            SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes <= charge * 2
        )


def test_session_revocation_while_waiting_for_review_lock_is_rechecked() -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    key = teacher.session.session_key
    waiting = Event()

    def before_lock(identifier: uuid.UUID) -> Assignment:
        waiting.set()
        return lock_assignment(identifier)

    def commit() -> tuple[int, str]:
        publication, _ = services.publish_feedback(
            record.assignment.created_by,
            key,
            record.assignment_id,
            record.id,
            expected_revision=1,
            client_request_id=uuid.uuid4(),
        )
        return 201, str(publication.id)

    with (
        patch.object(services, "lock_assignment", side_effect=before_lock),
        ThreadPoolExecutor(max_workers=1) as pool,
    ):
        with transaction.atomic():
            Workspace.objects.select_for_update().get(id=record.workspace_id)
            future = pool.submit(thread_call, commit)
            assert waiting.wait(timeout=10)
            Session.objects.filter(session_key=key).delete()
        result = future.result(timeout=20)
    assert result[0] == 403, result
    assert (
        FeedbackPublication.objects.count() == 0
        and InstructorFeedback.objects.get().revision == 1
    )

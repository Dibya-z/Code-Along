from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from threading import Barrier, Event
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import close_old_connections, transaction
from rest_framework.exceptions import APIException

from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning import participation_services
from code_along.learning.models import AssignmentWork
from code_along.learning.tests.test_assignments import write
from code_along.learning.tests.test_participation import work_body
from code_along.projects.models import ProjectRevision
from code_along.submissions import policies, services
from code_along.submissions.models import (
    Submission,
    SubmissionAssignmentUsage,
    SubmissionParticipant,
    SubmissionWorkspaceUsage,
)
from code_along.submissions.tests.test_policy import team_fixture
from code_along.submissions.tests.test_sequences import set_attempt_policy
from code_along.submissions.tests.test_submissions import candidate, fixture
from code_along.workspaces.models import Workspace

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def thread_call(callback: Callable[[], tuple[int, str]]) -> tuple[int, str]:
    close_old_connections()
    try:
        return callback()
    except APIException as error:
        code = (
            str(error.detail.get("code", "policy_denied"))
            if isinstance(error.detail, dict)
            else "policy_denied"
        )
        return error.status_code, code
    finally:
        close_old_connections()


def attempt(
    work: AssignmentWork,
    session_key: str | None,
    selected: services.PreparedSubmission,
    barrier: Barrier,
    actor: User | None = None,
) -> tuple[int, str]:
    barrier.wait(timeout=10)
    record, created = services.submit(
        actor or work.created_by, session_key, work.assignment_id, work.id, selected
    )
    return (201 if created else 200), str(record.id)


def assert_one_atomic_record(participants: int = 1) -> None:
    assert Submission.objects.count() == 1
    assert SubmissionParticipant.objects.count() == participants
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 1
    assert (
        SubmissionAssignmentUsage.objects.get().count
        == SubmissionWorkspaceUsage.objects.get().count
        == 1
    )


def test_concurrent_identical_nonce_commits_once_and_returns_original_receipt() -> None:
    teacher, client, assignment, work = fixture()
    selected = services.prepare(candidate(work), work.id)
    barrier = Barrier(2)
    key = client.session.session_key
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(thread_call, lambda: attempt(work, key, selected, barrier))
            for _ in range(2)
        ]
        results = [future.result(timeout=20) for future in futures]
    assert sorted(status for status, _ in results) == [200, 201], results
    assert results[0][1] == results[1][1]
    assert_one_atomic_record()


def test_concurrent_changed_bodies_with_same_nonce_return_one_conflict() -> None:
    teacher, client, assignment, work = fixture()
    first = candidate(work, "first H")
    second = candidate(work, "second H", nonce=first["client_request_id"])
    captures = [services.prepare(body, work.id) for body in (first, second)]
    barrier = Barrier(2)
    key = client.session.session_key
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(thread_call, partial(attempt, work, key, chosen, barrier))
            for chosen in captures
        ]
        results = [future.result(timeout=20) for future in futures]
    assert sorted(status for status, _ in results) == [201, 409], results
    assert (409, "submission_nonce_conflict") in results
    assert_one_atomic_record()
    assert Submission.objects.get().revision.files.get().source in {
        "first H",
        "second H",
    }


@pytest.mark.parametrize(
    "cap",
    [
        "ASSIGNMENT_SUBMISSION_LIMIT",
        "WORKSPACE_SUBMISSION_LIMIT",
        "ASSIGNMENT_SOURCE_BYTES",
        "WORKSPACE_SOURCE_BYTES",
    ],
)
def test_concurrent_reachable_count_or_byte_boundary_commits_only_one_candidate(
    cap: str,
) -> None:
    teacher, client, assignment, work = fixture()
    choices = [services.prepare(candidate(work, "x"), work.id) for _ in range(2)]
    barrier = Barrier(2)
    key = client.session.session_key
    with patch.object(policies, cap, 1), ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(thread_call, partial(attempt, work, key, chosen, barrier))
            for chosen in choices
        ]
        results = [future.result(timeout=20) for future in futures]
    assert sorted(status for status, _ in results) == [201, 409], results
    assert_one_atomic_record()
    assert (
        SubmissionAssignmentUsage.objects.get().source_bytes
        == SubmissionWorkspaceUsage.objects.get().source_bytes
        == 1
    )


def test_concurrent_team_authors_cannot_double_consume_last_per_person_attempt() -> (
    None
):
    teacher, first, second, member, assignment, old = team_fixture()
    set_attempt_policy(teacher, assignment, 1)
    response = write(
        first,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, old.created_by),
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    choices = [services.prepare(candidate(work, ""), work.id) for _ in range(2)]
    barrier = Barrier(2)
    actors = [
        (old.created_by, first.session.session_key),
        (member, second.session.session_key),
    ]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                thread_call,
                partial(attempt, work, key, chosen, barrier, user),
            )
            for chosen, (user, key) in zip(choices, actors, strict=True)
        ]
        results = [future.result(timeout=20) for future in futures]
    assert sorted(status for status, _ in results) == [201, 409], results
    assert (409, "submission_attempt_limit") in results
    assert_one_atomic_record(2)
    assert set(
        SubmissionParticipant.objects.values_list("attempt_number", flat=True)
    ) == {1}


def test_concurrent_withdrawal_and_submission_never_leave_partial_consumption() -> None:
    teacher, client, assignment, work = fixture()
    selected = services.prepare(candidate(work), work.id)
    key = client.session.session_key
    participation = work.participation
    assert participation is not None
    revision = participation.revision
    barrier = Barrier(2)

    def withdraw() -> tuple[int, str]:
        barrier.wait(timeout=10)
        record = participation_services.transition_participation(
            work.created_by,
            key,
            assignment.id,
            action="withdraw",
            expected_revision=revision,
        )
        return 200, record.state

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(thread_call, lambda: attempt(work, key, selected, barrier)),
            pool.submit(thread_call, withdraw),
        ]
        result, withdrawn = [future.result(timeout=20) for future in futures]
    assert withdrawn == (200, "withdrawn")
    work.refresh_from_db()
    assert work.state == "retired"
    if result[0] == 201:
        assert_one_atomic_record()
        record, repeated = services.submit(
            work.created_by, key, assignment.id, work.id, selected
        )
        assert not repeated and str(record.id) == result[1]
    else:
        assert result[0] == 409, result
        assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
        assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0
        assert (
            SubmissionAssignmentUsage.objects.count()
            == SubmissionWorkspaceUsage.objects.count()
            == 0
        )


def test_session_revoked_while_waiting_for_workspace_lock_is_not_cached_authority() -> (
    None
):
    teacher, client, assignment, work = fixture()
    selected = services.prepare(candidate(work), work.id)
    key = client.session.session_key
    waiting = Event()
    real = participation_services.lock_learning

    def announce_wait(identifier: Any) -> Any:
        waiting.set()
        return real(identifier)

    with (
        patch.object(services, "lock_learning", side_effect=announce_wait),
        ThreadPoolExecutor(max_workers=1) as pool,
    ):
        with transaction.atomic():
            Workspace.objects.select_for_update().get(id=assignment.workspace_id)
            future = pool.submit(
                thread_call, lambda: attempt(work, key, selected, Barrier(1))
            )
            assert waiting.wait(timeout=10)
            Session.objects.filter(session_key=key).delete()
        result = future.result(timeout=20)
    assert result[0] == 403, result
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0

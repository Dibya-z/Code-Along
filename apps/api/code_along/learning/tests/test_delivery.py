import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from threading import Barrier
from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from django.db import connection, transaction
from django.utils import timezone

from code_along.events import dispatcher
from code_along.events.models import InvalidationDelivery, OutboxEvent
from code_along.events.tests.test_dispatcher import background, private_row, public_row
from code_along.learning import delivery
from code_along.learning.models import Assignment, LearningNotificationStream
from code_along.learning.notification_types import stream_group
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import Workspace
from code_along.workspaces.tests.test_workspaces import person


@pytest.fixture
def workspace() -> Workspace:
    return workspaces.create_workspace(person("learning-delivery"), "Delivery fixture")


def pending(workspace: Workspace, **fields: Any) -> LearningNotificationStream:
    assignment = Assignment.objects.create(
        workspace=workspace, created_by=workspace.created_by, draft_title="Private head"
    )
    return LearningNotificationStream.objects.create(
        assignment=assignment,
        workspace=workspace,
        head_generation=1,
        **fields,
    )


def test_learning_publisher_uses_copied_claim_generation_and_only_private_group() -> (
    None
):
    row = LearningNotificationStream(
        assignment_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        head_generation=99,
        claim_generation=98,
    )
    claim = delivery.LearningClaim(row, uuid.uuid4(), timezone.now(), 7)
    with patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send:
        assert dispatcher._publish_learning(claim) is None
    send.assert_awaited_once_with(
        stream_group(delivery.identity(row)),
        {
            "type": "learning.changed",
            "stream_id": str(row.id),
            "generation": 7,
        },
    )
    for invalid in (0, True, 2**63):
        with patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send:
            assert (
                dispatcher._publish_learning(replace(claim, generation=invalid))
                == "invalid_delivery"
            )
        send.assert_not_called()
    row.participation_id = uuid.uuid4()
    with patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send:
        assert dispatcher._publish_learning(claim) == "invalid_delivery"
    send.assert_not_called()


@pytest.mark.parametrize(
    "counts",
    [
        (10, 10, 10),
        (10, 10, 0),
        (10, 0, 10),
        (0, 10, 10),
        (0, 0, 10),
        (1, 2, 3),
        (0, 0, 0),
    ],
)
def test_one_batch_reserves_all_queues_then_interleaves_spare_fill(
    counts: tuple[int, int, int],
) -> None:
    # Exercise the allocation algorithm independently of database ordering/locking.
    pools = [
        [f"{queue}-{i}" for i in range(count)] for queue, count in enumerate(counts)
    ]

    def take(queue: int, count: int) -> list[Any]:
        result, pools[queue] = pools[queue][:count], pools[queue][count:]
        return result

    def old(model: Any, count: int, now: Any) -> list[Any]:
        return take(0 if model is InvalidationDelivery else 1, count)

    with (
        patch.object(dispatcher, "_autocommit_required"),
        patch.object(transaction, "atomic", return_value=MagicMock()),
        patch.object(dispatcher, "_select_claims", side_effect=old),
        patch.object(
            dispatcher,
            "select_learning_claims",
            side_effect=lambda count, now: take(2, count),
        ),
    ):
        claims = cast(list[str], dispatcher.claim_batch())
    assert len(claims) == min(8, sum(counts))
    if all(counts):
        assert {value.split("-")[0] for value in claims[:3]} == {"0", "1", "2"}
        assert all(
            sum(value.startswith(str(q)) for value in claims) >= min(counts[q], 2)
            for q in range(3)
        )
    if counts == (10, 10, 0):
        assert [value.split("-")[0] for value in claims] == ["0", "1"] * 4


@pytest.mark.parametrize("operation", ["claim", "mark"])
def test_learning_claim_and_mark_enforce_transaction_boundaries(
    operation: str,
) -> None:
    fake = MagicMock(in_atomic_block=operation == "mark")
    with (
        patch.object(delivery, "connection", fake),
        pytest.raises(delivery.LearningDeliveryUnavailable),
    ):
        if operation == "claim":
            delivery.select_learning_claims(1, timezone.now())
        else:
            delivery.mark_learning_claim(
                delivery.LearningClaim(
                    LearningNotificationStream(), uuid.uuid4(), timezone.now(), 1
                )
            )


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_new_head_during_io_is_not_acknowledged_and_next_claim_coalesces(
    workspace: Workspace,
) -> None:
    row = pending(workspace)
    claim = dispatcher.claim_batch()[0]
    assert isinstance(claim, delivery.LearningClaim) and claim.generation == 1
    assert not connection.in_atomic_block
    # Producers bump under their domain transaction; a later head must survive g's ack.
    LearningNotificationStream.objects.filter(id=row.id).update(head_generation=2)
    LearningNotificationStream.objects.filter(id=row.id).update(head_generation=3)
    assert delivery.mark_learning_claim(claim)
    row.refresh_from_db()
    assert (row.head_generation, row.published_generation, row.claim_generation) == (
        3,
        1,
        None,
    )
    assert row.lock_token is None and row.locked_until is None and row.attempts == 0
    next_claim = dispatcher.claim_batch()[0]
    assert isinstance(next_claim, delivery.LearningClaim) and next_claim.generation == 3
    assert delivery.mark_learning_claim(next_claim)
    row.refresh_from_db()
    assert row.published_generation == row.head_generation == 3
    assert row.claim_generation is row.lock_token is row.locked_until is None
    assert dispatcher.claim_batch() == []


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_retry_expiry_and_stale_outcomes_preserve_captured_generation(
    workspace: Workspace,
) -> None:
    row = pending(workspace, attempts=1_000_000)
    first = dispatcher.claim_batch()[0]
    assert isinstance(first, delivery.LearningClaim)
    LearningNotificationStream.objects.filter(id=row.id).update(head_generation=2)
    before = timezone.now()
    assert delivery.mark_learning_claim(first, "channel_unavailable")
    row.refresh_from_db()
    assert row.claim_generation == 1 and row.published_generation == 0
    assert row.attempts == 1_000_000 and row.last_error_code == "channel_unavailable"
    assert (
        before + timedelta(seconds=60)
        <= row.available_at
        <= timezone.now() + timedelta(seconds=60)
    )
    assert dispatcher.claim_batch() == []
    with patch.object(timezone, "now", return_value=row.available_at):
        retry = dispatcher.claim_batch()[0]
    assert isinstance(retry, delivery.LearningClaim) and retry.generation == 1
    with patch.object(timezone, "now", return_value=retry.deadline):
        assert not delivery.mark_learning_claim(retry)
        assert not delivery.mark_learning_claim(retry, "channel_unavailable")
        current = dispatcher.claim_batch()[0]
        assert isinstance(current, delivery.LearningClaim) and current.generation == 1
        assert current.token != retry.token
        assert not delivery.mark_learning_claim(retry)
        assert not delivery.mark_learning_claim(first, "channel_unavailable")
        assert delivery.mark_learning_claim(current)
    row.refresh_from_db()
    assert row.published_generation == 1 and row.head_generation == 2


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_dispatch_io_sees_committed_claim_and_crash_retries_same_stream_generation(
    workspace: Workspace,
) -> None:
    row = pending(workspace)
    seen = []

    async def send(group: str, message: dict[str, Any]) -> None:
        assert not connection.in_atomic_block

        def visible() -> tuple[uuid.UUID | None, int | None]:
            stream = LearningNotificationStream.objects.get(id=row.id)
            return stream.lock_token, stream.claim_generation

        with ThreadPoolExecutor(max_workers=1) as executor:
            token, captured = executor.submit(background, visible).result(timeout=3)
        assert token is not None and captured == message["generation"]
        seen.append((group, message))

    class FixtureCrash(BaseException):
        pass

    with (
        patch.object(dispatcher, "_group_send", side_effect=send),
        patch.object(dispatcher, "mark_learning_claim", side_effect=FixtureCrash),
        pytest.raises(FixtureCrash),
    ):
        dispatcher.dispatch_batch()
    row.refresh_from_db()
    assert row.locked_until is not None
    LearningNotificationStream.objects.filter(id=row.id).update(head_generation=2)
    with (
        patch.object(
            timezone, "now", return_value=row.locked_until + timedelta(milliseconds=1)
        ),
        patch.object(dispatcher, "_group_send", side_effect=send),
    ):
        assert dispatcher.dispatch_batch().published == 1
    assert (
        seen
        == [
            (
                stream_group(delivery.identity(row)),
                {
                    "type": "learning.changed",
                    "stream_id": str(row.id),
                    "generation": 1,
                },
            )
        ]
        * 2
    )


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_skip_locked_claims_are_disjoint_and_parent_domain_locks_do_not_block(
    workspace: Workspace,
) -> None:
    rows = [pending(workspace) for _ in range(16)]
    barrier = Barrier(2)

    def claim() -> set[uuid.UUID]:
        barrier.wait(timeout=3)
        return {item.row.id for item in dispatcher.claim_batch()}

    with transaction.atomic(), ThreadPoolExecutor(max_workers=2) as executor:
        Assignment.objects.select_for_update().get(id=rows[0].assignment_id)
        a, b = executor.submit(background, claim), executor.submit(background, claim)
        first, second = a.result(timeout=5), b.result(timeout=5)
    assert len(first) == len(second) == 8 and not first & second


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_three_busy_queues_share_eight_and_old_two_queue_coverage_remains(
    workspace: Workspace,
) -> None:
    from code_along.collaboration.tests.catalog import ensure_runtime_catalog
    from code_along.projects import services as projects

    ensure_runtime_catalog()
    project = projects.create_project(
        workspace.created_by, workspace.id, "Public source"
    )
    OutboxEvent.objects.all().delete()
    for index in range(10):
        public_row(project, index + 1)
        private_row()
        pending(workspace)
    claims = dispatcher.claim_batch()
    assert len(claims) == 8
    assert sum(isinstance(item, delivery.LearningClaim) for item in claims) == 2
    assert sum(isinstance(item.row, OutboxEvent) for item in claims) == 3
    assert sum(isinstance(item.row, InvalidationDelivery) for item in claims) == 3
    assert all(isinstance(item, delivery.LearningClaim) for item in claims[2::3])

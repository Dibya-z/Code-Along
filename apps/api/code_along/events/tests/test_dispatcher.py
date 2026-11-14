import asyncio
import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from typing import Any
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest
from asgiref.sync import async_to_sync
from config.celery import app
from django.contrib.sessions.models import Session
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import (
    DatabaseError,
    close_old_connections,
    connection,
    connections,
    transaction,
)
from django.test import override_settings
from django.utils import timezone
from kombu.exceptions import LimitExceeded

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.events import dispatcher, tasks
from code_along.events.models import InvalidationDelivery, OutboxEvent
from code_along.events.services import project_group, public_event, session_group
from code_along.projects import services as projects
from code_along.projects.models import Project
from code_along.workspaces import services as workspaces
from code_along.workspaces.tests.test_workspaces import person


@pytest.fixture
def project() -> Project:
    ensure_runtime_catalog()
    owner = person("outbox-owner")
    workspace = workspaces.create_workspace(owner, "Outbox fixtures")
    project = projects.create_project(owner, workspace.id, "Outbox project")
    OutboxEvent.objects.all().delete()
    InvalidationDelivery.objects.all().delete()
    return project


def public_row(project: Project, sequence: int = 1, **fields: Any) -> OutboxEvent:
    return OutboxEvent.objects.create(
        project=project,
        sequence=sequence,
        event_type="project.changed",
        payload={"metadata_version": sequence},
        **fields,
    )


def private_row(**fields: Any) -> InvalidationDelivery:
    return InvalidationDelivery.objects.create(lease_ids=[str(uuid.uuid4())], **fields)


def background(work: Any) -> Any:
    """A separate real DB connection, always closed before the owned test ends."""
    close_old_connections()
    try:
        return work()
    finally:
        connections.close_all()


@pytest.mark.parametrize("limit", [0, 9, True, 1.5])
def test_dispatch_limits_are_closed_before_database_access(limit: Any) -> None:
    with pytest.raises(ValueError, match="invalid_dispatch_limit"):
        dispatcher.claim_batch(limit)


@pytest.mark.parametrize("operation", ["claim", "mark"])
def test_connection_failures_have_only_a_bounded_public_error(operation: str) -> None:
    failing = MagicMock()
    failing.in_atomic_block = False
    failing.get_autocommit.side_effect = DatabaseError("PRIVATE_DATABASE_DETAILS")
    row = OutboxEvent(project_id=uuid.uuid4(), sequence=1)
    claim = dispatcher.Claim(row, uuid.uuid4(), timezone.now())
    with (
        patch.object(dispatcher, "connection", failing),
        pytest.raises(
            dispatcher.DispatchUnavailable, match="^outbox_unavailable$"
        ) as error,
    ):
        if operation == "claim":
            dispatcher.claim_batch()
        else:
            dispatcher.mark_claim(claim)
    assert error.value.__suppress_context__


def test_channel_timeout_cancels_the_actual_await_and_uses_no_fallback() -> None:
    cancelled = []

    async def wait_forever(*_: Any) -> None:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    layer = MagicMock()
    layer.group_send = wait_forever
    with (
        patch.object(dispatcher, "get_channel_layer", return_value=layer),
        patch.object(dispatcher, "CHANNEL_TIMEOUT", 0.01),
        pytest.raises(TimeoutError),
    ):
        async_to_sync(dispatcher._group_send)("project.fixture", {"type": "fixture"})
    assert cancelled == [True]
    with (
        patch.object(dispatcher, "get_channel_layer", return_value=None),
        pytest.raises(RuntimeError, match="channel_unavailable"),
    ):
        async_to_sync(dispatcher._group_send)("project.fixture", {"type": "fixture"})


def test_public_publication_uses_the_committed_safe_projection_and_group() -> None:
    row = OutboxEvent(
        project_id=uuid.uuid4(),
        sequence=1,
        event_type="project.changed",
        payload={"metadata_version": 4},
        occurred_at=timezone.now(),
    )
    layer = MagicMock()
    layer.group_send = AsyncMock()
    with patch.object(dispatcher, "get_channel_layer", return_value=layer):
        assert dispatcher._publish_public(row) is None
    args = layer.group_send.call_args.args
    assert args[0] == project_group(row.project_id)
    assert args[1]["type"] == "project.event"
    assert args[1]["event"]["id"] == str(row.id)
    assert args[1]["event"]["data"] == {"metadata_version": 4}
    assert set(args[1]) == {"type", "event"}


def test_private_partial_failure_keeps_stable_identity_and_never_emits_a_public_event() -> (
    None
):
    row = InvalidationDelivery(
        lease_ids=[str(uuid.uuid4())],
        session_group=session_group("owned-fixture-session"),
    )
    layer = MagicMock()
    layer.group_send = AsyncMock()
    with (
        patch.object(dispatcher, "get_channel_layer", return_value=layer),
        patch.object(
            dispatcher,
            "post_control",
            side_effect=RuntimeError("PRIVATE_DRIVER_AND_TOKEN"),
        ) as control,
        patch.object(dispatcher, "public_event") as public,
    ):
        assert dispatcher._publish_private(row) == "control_unavailable"
        assert dispatcher._publish_private(row) == "control_unavailable"
    public.assert_not_called()
    assert control.call_args.kwargs == {"maximum": 1024, "timeout": 0.25}
    assert control.call_args.args == (
        "/internal/v1/invalidations/",
        {
            "version": 1,
            "event_id": str(row.id),
            "lease_ids": row.lease_ids,
            "reason": "authorization_changed",
        },
    )
    layer.group_send.assert_awaited_with(
        row.session_group, {"type": "access.invalidated"}
    )


def test_private_session_only_delivery_does_not_require_a_node_call() -> None:
    row = InvalidationDelivery(
        lease_ids=[], session_group=session_group("logout-fixture")
    )
    with (
        patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send,
        patch.object(dispatcher, "post_control") as control,
    ):
        assert dispatcher._publish_private(row) is None
    control.assert_not_called()
    send.assert_awaited_once_with(row.session_group, {"type": "access.invalidated"})


@pytest.mark.parametrize(
    "fields",
    [
        {"lease_ids": ["not-a-uuid"]},
        {"lease_ids": [str(uuid.uuid4())] * 129},
        {"lease_ids": [], "session_group": None},
        {"lease_ids": [], "session_group": "project.private-data"},
    ],
)
def test_malformed_private_rows_do_not_publish_or_reflect_payload(
    fields: dict[str, Any],
) -> None:
    row = InvalidationDelivery(**fields)
    with (
        patch.object(dispatcher, "post_control") as control,
        patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send,
    ):
        assert dispatcher._publish_private(row) == "invalid_delivery"
    control.assert_not_called()
    send.assert_not_called()


def test_task_is_bound_to_explicit_app_with_no_arguments_and_counts_only() -> None:
    assert tasks.dispatch_outbox.app is app
    assert tasks.dispatch_outbox.name == "code_along.events.dispatch_outbox"
    with patch.object(
        tasks, "dispatch_batch", return_value=dispatcher.DispatchStats(8, 5, 2, 1)
    ):
        assert tasks.dispatch_outbox.run() == {
            "claimed": 8,
            "published": 5,
            "retried": 2,
            "lost": 1,
        }
    with patch.object(
        tasks, "dispatch_batch", side_effect=dispatcher.DispatchUnavailable()
    ):
        assert tasks.dispatch_outbox.run() == {"unavailable": 1}
    with pytest.raises(TypeError):
        tasks.dispatch_outbox.run("untrusted argument")  # type: ignore[call-arg]


def test_wakeup_is_best_effort_after_commit_and_never_runs_an_eager_fallback(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with (
        override_settings(CELERY_BROKER_URL=None),
        patch.object(tasks.dispatch_outbox, "apply_async") as send,
    ):
        tasks.wake_dispatcher()
    send.assert_not_called()
    pool, producer = MagicMock(), object()
    pool.acquire.return_value.__enter__.return_value = producer
    with (
        override_settings(CELERY_BROKER_URL="redis://owned-fixture.invalid/0"),
        patch.object(
            type(app), "producer_pool", new_callable=PropertyMock, return_value=pool
        ),
        patch.object(
            tasks.dispatch_outbox,
            "apply_async",
            side_effect=RuntimeError("PRIVATE_BROKER_CREDENTIAL"),
        ) as send,
        patch.object(tasks.dispatch_outbox, "run") as eager,
    ):
        tasks.wake_dispatcher()
    send.assert_called_once_with(
        retry=False, serializer="json", ignore_result=True, expires=5, producer=producer
    )
    pool.acquire.assert_called_once_with(block=False)
    pool.acquire.return_value.__exit__.assert_called_once()
    eager.assert_not_called()
    captured = capsys.readouterr()
    assert not captured.out and not captured.err


def test_exhausted_producer_pool_skips_wakeup_without_waiting_or_publishing() -> None:
    pool = MagicMock()
    pool.acquire.side_effect = LimitExceeded("fixture-full")
    with (
        override_settings(CELERY_BROKER_URL="redis://owned-fixture.invalid/0"),
        patch.object(
            type(app), "producer_pool", new_callable=PropertyMock, return_value=pool
        ),
        patch.object(tasks.dispatch_outbox, "apply_async") as send,
        patch.object(tasks.dispatch_outbox, "run") as eager,
    ):
        tasks.wake_dispatcher()
    pool.acquire.assert_called_once_with(block=False)
    send.assert_not_called()
    eager.assert_not_called()


def test_command_runs_once_and_reports_only_bounded_counts() -> None:
    output = io.StringIO()
    with patch(
        "code_along.events.management.commands.dispatch_outbox.dispatch_batch",
        return_value=dispatcher.DispatchStats(2, 1, 1, 0),
    ) as dispatch:
        call_command("dispatch_outbox", stdout=output)
    dispatch.assert_called_once_with()
    assert (
        output.getvalue() == "Claimed 2; published 1; retrying 1; ownership lost 0.\n"
    )
    with (
        patch(
            "code_along.events.management.commands.dispatch_outbox.dispatch_batch",
            side_effect=dispatcher.DispatchUnavailable(),
        ),
        pytest.raises(CommandError, match="Outbox dispatcher unavailable"),
    ):
        call_command("dispatch_outbox", stdout=io.StringIO())


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_claims_are_committed_fair_bounded_and_fill_unused_queue_capacity(
    project: Project,
) -> None:
    for index in range(10):
        public_row(project, index + 1)
        private_row()
    claims = dispatcher.claim_batch()
    assert len(claims) == 8
    assert sum(isinstance(claim.row, OutboxEvent) for claim in claims) == 4
    assert sum(isinstance(claim.row, InvalidationDelivery) for claim in claims) == 4
    assert not connection.in_atomic_block
    assert all(
        claim.row.attempts == 1 and claim.deadline == claim.row.locked_until
        for claim in claims
    )
    assert all(claim.row.lock_token == claim.token for claim in claims)
    assert len({claim.token for claim in claims}) == 8
    assert len(dispatcher.claim_batch()) == 8
    assert len(dispatcher.claim_batch()) == 4
    assert dispatcher.claim_batch() == []
    OutboxEvent.objects.all().delete()
    InvalidationDelivery.objects.all().delete()
    for index in range(10):
        public_row(project, index + 1)
    assert len(dispatcher.claim_batch()) == 8


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_simultaneous_workers_claim_disjoint_rows_with_skip_locked(
    project: Project,
) -> None:
    for index in range(8):
        public_row(project, index + 1)
        private_row()
    start = Barrier(2)

    def work() -> set[uuid.UUID]:
        start.wait(timeout=3)
        return {claim.row.id for claim in dispatcher.claim_batch()}

    with ThreadPoolExecutor(max_workers=2) as executor:
        a = executor.submit(background, work)
        b = executor.submit(background, work)
        first, second = a.result(timeout=5), b.result(timeout=5)
    assert len(first) == len(second) == 8 and not first & second


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_locked_and_uncommitted_rows_are_not_waited_on_or_published(
    project: Project,
) -> None:
    first, second = public_row(project), public_row(project, 2)
    with ThreadPoolExecutor(max_workers=1) as executor:
        with transaction.atomic():
            OutboxEvent.objects.select_for_update().get(id=first.id)
            claimed = executor.submit(
                background, lambda: dispatcher.claim_batch(1)
            ).result(timeout=3)
            assert [claim.row.id for claim in claimed] == [second.id]
        with transaction.atomic():
            public_row(project, 3)
            with pytest.raises(dispatcher.DispatchUnavailable):
                dispatcher.dispatch_batch()
            claimed = executor.submit(background, dispatcher.claim_batch).result(
                timeout=3
            )
            assert [claim.row.id for claim in claimed] == [first.id]
    assert len(dispatcher.claim_batch()) == 1


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_expired_claims_retry_same_uuid_and_stale_or_expired_owners_cannot_mark(
    project: Project,
) -> None:
    row = public_row(project)
    first = dispatcher.claim_batch()[0]
    after = first.deadline + timedelta(milliseconds=1)
    with patch.object(timezone, "now", return_value=after):
        assert not dispatcher.mark_claim(first)
        second = dispatcher.claim_batch()[0]
        assert second.row.id == row.id and second.token != first.token
        assert not dispatcher.mark_claim(first)
        assert not dispatcher.mark_claim(first, "channel_unavailable")
        assert dispatcher.mark_claim(second)
    row.refresh_from_db()
    assert (
        row.delivered_at == after
        and row.lock_token is None
        and row.locked_until is None
    )
    assert row.attempts == 2


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_network_runs_after_claim_commit_and_success_is_publication_not_recipient_receipt(
    project: Project,
) -> None:
    row = public_row(project)
    seen = []

    async def send(group: str, message: dict[str, Any]) -> None:
        seen.append((group, message))

    def projection(event: OutboxEvent) -> dict[str, Any]:
        assert not connection.in_atomic_block
        with ThreadPoolExecutor(max_workers=1) as executor:
            token = executor.submit(
                background, lambda: OutboxEvent.objects.get(id=event.id).lock_token
            ).result(timeout=3)
        assert (
            token == event.lock_token
        )  # A different connection sees the committed claim.
        return public_event(event)

    with (
        patch.object(dispatcher, "public_event", side_effect=projection),
        patch.object(dispatcher, "_group_send", side_effect=send),
    ):
        counts = dispatcher.dispatch_batch().counts()
    assert counts == {"claimed": 1, "published": 1, "retried": 0, "lost": 0}
    assert len(seen) == 1 and seen[0][1]["event"]["id"] == str(row.id)
    row.refresh_from_db()
    assert (
        row.delivered_at is not None
    )  # No assertion that any consumer read the event.


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_publish_then_crash_duplicates_the_same_event_after_expiring_claim(
    project: Project,
) -> None:
    row = public_row(project)
    published: list[str] = []

    async def send(group: str, message: dict[str, Any]) -> None:
        published.append(message["event"]["id"])

    class FixtureCrash(BaseException):
        pass

    with (
        patch.object(dispatcher, "_group_send", side_effect=send),
        patch.object(dispatcher, "mark_claim", side_effect=FixtureCrash),
    ):
        with pytest.raises(FixtureCrash):
            dispatcher.dispatch_batch()
    row.refresh_from_db()
    assert row.delivered_at is None and row.locked_until is not None
    after = row.locked_until + timedelta(milliseconds=1)
    with (
        patch.object(timezone, "now", return_value=after),
        patch.object(dispatcher, "_group_send", side_effect=send),
    ):
        assert dispatcher.dispatch_batch().published == 1
    assert published == [str(row.id), str(row.id)]


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_failures_retry_with_bounded_codes_backoff_and_saturated_attempt_counter(
    project: Project, capsys: pytest.CaptureFixture[str]
) -> None:
    row = public_row(project, attempts=dispatcher.MAX_RECORDED_ATTEMPTS)
    before = timezone.now()
    with patch.object(
        dispatcher, "_group_send", side_effect=RuntimeError("PRIVATE_SOURCE_OR_TOKEN")
    ):
        assert dispatcher.dispatch_batch().retried == 1
    row.refresh_from_db()
    assert row.attempts == dispatcher.MAX_RECORDED_ATTEMPTS
    assert row.last_error_code == "channel_unavailable" and row.delivered_at is None
    assert row.lock_token is None and row.locked_until is None
    assert (
        before + timedelta(seconds=60)
        <= row.available_at
        <= timezone.now() + timedelta(seconds=60)
    )
    assert dispatcher.claim_batch() == []
    captured = capsys.readouterr()
    assert "PRIVATE" not in captured.out + captured.err


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_private_payload_survives_session_deletion_and_never_enters_public_queue(
    project: Project,
) -> None:
    key = "a" * 32
    Session.objects.create(
        session_key=key,
        session_data="",
        expire_date=timezone.now() + timedelta(hours=1),
    )
    row = private_row(session_group=session_group(key))
    Session.objects.get(session_key=key).delete()
    assert InvalidationDelivery.objects.filter(id=row.id).exists()
    with (
        patch.object(
            dispatcher, "post_control", return_value={"version": 1, "status": "ok"}
        ),
        patch.object(dispatcher, "_group_send", new_callable=AsyncMock) as send,
    ):
        assert dispatcher.dispatch_batch().published == 1
    send.assert_awaited_once_with(row.session_group, {"type": "access.invalidated"})
    assert not OutboxEvent.objects.exists()

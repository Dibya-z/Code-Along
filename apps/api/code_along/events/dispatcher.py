"""Bounded, at-least-once delivery of committed public events/private invalidations.

Claim transactions finish before network I/O. A crash after publication can
repeat the same stable event UUID; publication never proves recipient delivery.
"""

import asyncio
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Protocol, cast

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import DatabaseError, connection, transaction
from django.db.models import Q
from django.utils import timezone

from code_along.collaboration.control import post_control

from .contracts import uuid_value
from .models import InvalidationDelivery, OutboxEvent
from .services import project_group, public_event

MAX_BATCH = 8
CLAIM_SECONDS = 30
CHANNEL_TIMEOUT = 2.0
CONTROL_TIMEOUT = 0.25
MAX_RETRY_SECONDS = 60
MAX_RECORDED_ATTEMPTS = 1_000_000
SESSION_GROUP = re.compile(r"session\.[a-f0-9]{64}\Z")
Row = OutboxEvent | InvalidationDelivery
RowClass = type[OutboxEvent] | type[InvalidationDelivery]


class DispatchUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("outbox_unavailable")


class ChannelLayer(Protocol):
    async def group_send(self, group: str, message: dict[str, Any]) -> None: ...


@dataclass(frozen=True)
class Claim:
    row: Row
    token: uuid.UUID
    deadline: datetime


@dataclass
class DispatchStats:
    claimed: int = 0
    published: int = 0
    retried: int = 0
    lost: int = 0

    def counts(self) -> dict[str, int]:
        return {
            "claimed": self.claimed,
            "published": self.published,
            "retried": self.retried,
            "lost": self.lost,
        }


def _autocommit_required() -> None:
    if connection.in_atomic_block or not connection.get_autocommit():
        raise DispatchUnavailable()


def _select_claims(model: RowClass, limit: int, now: datetime) -> list[Claim]:
    if limit < 1:
        return []
    rows = cast(
        list[Row],
        list(
            model.objects.select_for_update(skip_locked=True)
            .filter(delivered_at__isnull=True, available_at__lte=now)
            .filter(Q(lock_token__isnull=True) | Q(locked_until__lte=now))
            .order_by("available_at", "id")[:limit]
        ),
    )
    claims = []
    for row in rows:
        token = uuid.uuid4()
        deadline = now + timedelta(seconds=CLAIM_SECONDS)
        # Saturation bounds the counter and exponent without discarding durable
        # pending rows during a prolonged broker outage.
        row.attempts = min(row.attempts + 1, MAX_RECORDED_ATTEMPTS)
        row.lock_token, row.locked_until = token, deadline
        row.save(update_fields=["attempts", "lock_token", "locked_until"])
        claims.append(Claim(row, token, deadline))
    return claims


def claim_batch(limit: int = MAX_BATCH) -> list[Claim]:
    """Reserve half for each queue, then fill unused capacity; commit before return."""
    if type(limit) is not int or not 1 <= limit <= MAX_BATCH:
        raise ValueError("invalid_dispatch_limit")
    try:
        _autocommit_required()
        now = timezone.now()
        with transaction.atomic():
            share = limit // 2
            private = _select_claims(InvalidationDelivery, share, now)
            public = _select_claims(OutboxEvent, share, now)
            remaining = limit - len(private) - len(public)
            private += _select_claims(InvalidationDelivery, remaining, now)
            remaining = limit - len(private) - len(public)
            public += _select_claims(OutboxEvent, remaining, now)
        ordered = []
        for index in range(max(len(private), len(public))):
            if index < len(private):
                ordered.append(private[index])
            if index < len(public):
                ordered.append(public[index])
        return ordered
    except DatabaseError:
        raise DispatchUnavailable() from None


def mark_claim(claim: Claim, error_code: str | None = None) -> bool:
    """A late/stale publisher cannot complete or clear another worker's claim."""
    allowed = {
        "projection_failed",
        "channel_unavailable",
        "control_unavailable",
        "invalid_delivery",
    }
    if error_code is not None and error_code not in allowed:
        raise ValueError("invalid_delivery_error")
    model: RowClass = (
        OutboxEvent if isinstance(claim.row, OutboxEvent) else InvalidationDelivery
    )
    try:
        _autocommit_required()
        with transaction.atomic():
            # A competing/administrative lock must not turn this short mark into
            # unbounded waiting, or allow an already-expired claim to publish.
            row = (
                model.objects.select_for_update(nowait=True)
                .filter(
                    id=claim.row.id, lock_token=claim.token, delivered_at__isnull=True
                )
                .first()
            )
            now = timezone.now()
            if row is None or row.locked_until is None or row.locked_until <= now:
                return False
            values: dict[str, Any] = {
                "lock_token": None,
                "locked_until": None,
                "last_error_code": error_code or "",
            }
            if error_code is None:
                values["delivered_at"] = now
            else:
                delay = min(2 ** min(row.attempts, 6), MAX_RETRY_SECONDS)
                values["available_at"] = now + timedelta(seconds=delay)
            return (
                model.objects.filter(
                    id=row.id,
                    lock_token=claim.token,
                    locked_until__gt=now,
                    delivered_at__isnull=True,
                ).update(**values)
                == 1
            )
    except DatabaseError:
        raise DispatchUnavailable() from None


async def _group_send(group: str, message: dict[str, Any]) -> None:
    factory = cast(Callable[[], ChannelLayer | None], get_channel_layer)
    layer = factory()
    if layer is None:
        raise RuntimeError("channel_unavailable")
    await asyncio.wait_for(layer.group_send(group, message), timeout=CHANNEL_TIMEOUT)


def _publish_public(row: OutboxEvent) -> str | None:
    try:
        event = public_event(row)
    except Exception:
        return "projection_failed"
    try:
        async_to_sync(_group_send)(
            project_group(row.project_id), {"type": "project.event", "event": event}
        )
        return None
    except Exception:
        return "channel_unavailable"


def _publish_private(row: InvalidationDelivery) -> str | None:
    try:
        if not isinstance(row.lease_ids, list) or len(row.lease_ids) > 128:
            raise ValueError("invalid_delivery")
        for identifier in row.lease_ids:
            uuid_value(identifier)
        if row.session_group is not None and not SESSION_GROUP.fullmatch(
            row.session_group
        ):
            raise ValueError("invalid_delivery")
        if not row.lease_ids and row.session_group is None:
            raise ValueError("invalid_delivery")
    except (TypeError, ValueError):
        return "invalid_delivery"
    error = None
    if row.lease_ids:
        try:
            result = post_control(
                "/internal/v1/invalidations/",
                {
                    "version": 1,
                    "event_id": str(row.id),
                    "lease_ids": row.lease_ids,
                    "reason": "authorization_changed",
                },
                maximum=1024,
                timeout=CONTROL_TIMEOUT,
            )
            if (
                set(result) != {"version", "status"}
                or type(result["version"]) is not int
                or result["version"] != 1
                or result["status"] != "ok"
            ):
                raise ValueError("invalid_delivery")
        except Exception:
            error = "control_unavailable"
    if row.session_group:
        try:
            async_to_sync(_group_send)(
                row.session_group, {"type": "access.invalidated"}
            )
        except Exception:
            error = error or "channel_unavailable"
    return error


def dispatch_batch() -> DispatchStats:
    """One finite batch. Periodic polling repairs missed best-effort wakeups."""
    stats = DispatchStats()
    claims = claim_batch()
    stats.claimed = len(claims)
    for claim in claims:
        if timezone.now() >= claim.deadline:
            stats.lost += 1
            continue
        error = (
            _publish_public(claim.row)
            if isinstance(claim.row, OutboxEvent)
            else _publish_private(claim.row)
        )
        if not mark_claim(claim, error):
            stats.lost += 1
        elif error is None:
            stats.published += 1
        else:
            stats.retried += 1
    return stats

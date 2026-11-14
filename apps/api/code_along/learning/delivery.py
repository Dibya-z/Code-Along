"""Short durable generation claims; callers publish only after their transaction commits."""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from django.db import DatabaseError, connection, transaction
from django.db.models import F, Q
from django.utils import timezone

from .models import LearningNotificationStream
from .notification_types import StreamIdentity

CLAIM_SECONDS = 30
MAX_RETRY_SECONDS = 60
MAX_RECORDED_ATTEMPTS = 1_000_000


class LearningDeliveryUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("outbox_unavailable")


@dataclass(frozen=True, slots=True)
class LearningClaim:
    row: LearningNotificationStream
    token: uuid.UUID
    deadline: datetime
    generation: int


def identity(row: LearningNotificationStream) -> StreamIdentity:
    return StreamIdentity(
        id=row.id,
        assignment_id=row.assignment_id,
        workspace_id=row.workspace_id,
        audience_user_id=row.audience_user_id,
        participation_id=row.participation_id,
    )


def select_learning_claims(limit: int, now: datetime) -> list[LearningClaim]:
    """Called inside the dispatcher's sole claim transaction, never performs I/O."""
    if not connection.in_atomic_block:
        raise LearningDeliveryUnavailable()
    if limit < 1:
        return []
    rows = (
        LearningNotificationStream.objects.select_for_update(skip_locked=True)
        .filter(head_generation__gt=F("published_generation"), available_at__lte=now)
        .filter(Q(lock_token__isnull=True) | Q(locked_until__lte=now))
        .order_by("available_at", "id")[:limit]
    )
    claims = []
    for row in rows:
        captured = row.claim_generation
        if captured is None:
            captured = row.head_generation
        token, deadline = uuid.uuid4(), now + timedelta(seconds=CLAIM_SECONDS)
        row.claim_generation = captured
        row.lock_token, row.locked_until = token, deadline
        row.attempts = min(row.attempts + 1, MAX_RECORDED_ATTEMPTS)
        row.save(
            update_fields=["claim_generation", "lock_token", "locked_until", "attempts"]
        )
        claims.append(LearningClaim(row, token, deadline, captured))
    return claims


def mark_learning_claim(claim: LearningClaim, error_code: str | None = None) -> bool:
    """Only the live token and captured generation may clear this claim."""
    if error_code is not None and error_code not in {
        "projection_failed",
        "channel_unavailable",
        "invalid_delivery",
    }:
        raise ValueError("invalid_delivery_error")
    try:
        if connection.in_atomic_block or not connection.get_autocommit():
            raise LearningDeliveryUnavailable()
        with transaction.atomic():
            row = (
                LearningNotificationStream.objects.select_for_update(nowait=True)
                .filter(
                    id=claim.row.id,
                    lock_token=claim.token,
                    claim_generation=claim.generation,
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
                values.update(
                    published_generation=claim.generation,
                    claim_generation=None,
                    attempts=0,
                    available_at=now,
                )
            else:
                delay = min(2 ** min(row.attempts, 6), MAX_RETRY_SECONDS)
                values["available_at"] = now + timedelta(seconds=delay)
            return (
                LearningNotificationStream.objects.filter(
                    id=row.id,
                    lock_token=claim.token,
                    locked_until__gt=now,
                    claim_generation=claim.generation,
                    published_generation__lt=claim.generation,
                ).update(**values)
                == 1
            )
    except DatabaseError:
        raise LearningDeliveryUnavailable() from None

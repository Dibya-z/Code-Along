"""Finite receipt maintenance; canonical state and named history are never collected."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Exists, OuterRef, Q
from django.db.models.deletion import Collector, ProtectedError, RestrictedError
from django.utils import timezone

from .models import CheckpointReceipt, DocumentState

RECENT_RECEIPTS = 2048
RECEIPT_LIFETIME = timedelta(hours=24)
HARD_RECEIPT_CAPACITY = 4096
MAX_DOCUMENTS = 16
MAX_CANDIDATES = 512


class RetentionUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("receipt_retention_unavailable")


@dataclass
class RetentionStats:
    documents: int = 0
    examined: int = 0
    eligible: int = 0
    protected: int = 0
    deleted: int = 0

    def counts(self) -> dict[str, int]:
        return {
            "documents": self.documents,
            "examined": self.examined,
            "eligible": self.eligible,
            "protected": self.protected,
            "deleted": self.deleted,
        }


def _receipt_collector(receipt: CheckpointReceipt) -> Collector | None:
    collector = Collector(using=connection.alias, origin=receipt)
    try:
        collector.collect([receipt])
    except (ProtectedError, RestrictedError):
        return None
    # Never cascade into provenance or null its relationship. Future relationships
    # must be reviewed rather than being silently erased by routine maintenance.
    if collector.field_updates or any(
        model is not CheckpointReceipt and objects
        for model, objects in collector.data.items()
    ):
        return None
    if any(
        query.model is not CheckpointReceipt and query.exists()
        for query in collector.fast_deletes
    ):
        return None
    return collector


def prune_checkpoint_receipts(
    *, apply: bool = False, now: datetime | None = None
) -> RetentionStats:
    """Preview by default. Lock at most16 eligible documents and inspect at most512 receipts."""
    instant = now or timezone.now()
    if timezone.is_naive(instant):
        raise ValueError("aware_retention_time_required")
    cutoff = instant - RECEIPT_LIFETIME
    receipts = CheckpointReceipt.objects.filter(document_id=OuterRef("document_id"))
    candidates = (
        DocumentState.objects.only("document")
        .annotate(
            expired=Exists(receipts.filter(recorded_at__lt=cutoff)),
            excess=Exists(
                receipts.order_by("-recorded_at", "-id")[
                    RECENT_RECEIPTS : RECENT_RECEIPTS + 1
                ]
            ),
        )
        .filter(Q(expired=True) | Q(excess=True))
        .order_by("updated_at", "document_id")
    )
    stats = RetentionStats()
    try:
        if connection.in_atomic_block or not connection.get_autocommit():
            raise RetentionUnavailable()
        with transaction.atomic():
            with connection.cursor() as cursor:
                # Own this transaction so deferred checks fail inside each
                # deletion savepoint without affecting any caller's constraints.
                cursor.execute("SET LOCAL lock_timeout = '250ms'")
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
            states = list(
                candidates.select_for_update(skip_locked=True, of=("self",))[
                    :MAX_DOCUMENTS
                ]
            )
            for state in states:
                if stats.examined >= MAX_CANDIDATES:
                    break
                stats.documents += 1
                document_receipts = CheckpointReceipt.objects.filter(
                    document_id=state.document_id
                )
                recent = list(
                    document_receipts.order_by("-recorded_at", "-id").values_list(
                        "id", flat=True
                    )[:RECENT_RECEIPTS]
                )
                selected = list(
                    document_receipts.filter(
                        Q(recorded_at__lt=cutoff) | ~Q(id__in=recent)
                    )
                    .select_for_update(skip_locked=True, of=("self",))
                    .order_by("recorded_at", "id")[: MAX_CANDIDATES - stats.examined]
                )
                for receipt in selected:
                    stats.examined += 1
                    collector = _receipt_collector(receipt)
                    if collector is None:
                        stats.protected += 1
                        continue
                    stats.eligible += 1
                    if apply:
                        try:
                            # A concurrently created or DO_NOTHING reference is
                            # retained by its FK; rollback only this attempted row.
                            with transaction.atomic():
                                _, deleted = collector.delete()
                        except IntegrityError:
                            stats.eligible -= 1
                            stats.protected += 1
                        else:
                            stats.deleted += deleted.get(
                                CheckpointReceipt._meta.label, 0
                            )
        return stats
    except DatabaseError:
        raise RetentionUnavailable() from None

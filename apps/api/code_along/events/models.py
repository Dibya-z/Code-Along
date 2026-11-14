import uuid

from django.db import models
from django.utils import timezone

EVENT_TYPES = [
    "project.changed",
    "project.access.changed",
    "revision.created",
    "chat.message.created",
]


class Delivery(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    available_at = models.DateTimeField(default=timezone.now)
    attempts = models.PositiveIntegerField(default=0)
    lock_token = models.UUIDField(null=True, blank=True)
    locked_until = models.DateTimeField(null=True, blank=True)
    delivered_at = models.DateTimeField(null=True, blank=True)
    last_error_code = models.CharField(max_length=32, default="", blank=True)

    class Meta:
        abstract = True
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(lock_token__isnull=True, locked_until__isnull=True)
                    | models.Q(lock_token__isnull=False, locked_until__isnull=False)
                ),
                name="%(app_label)s_%(class)s_claim_pair",
            )
        ]


class OutboxEvent(Delivery):
    project = models.ForeignKey(
        "projects.Project", on_delete=models.PROTECT, related_name="events"
    )
    sequence = models.PositiveBigIntegerField()
    version = models.PositiveSmallIntegerField(default=1)
    event_type = models.CharField(max_length=64)
    payload = models.JSONField()
    occurred_at = models.DateTimeField(auto_now_add=True)

    class Meta(Delivery.Meta):
        abstract = False
        constraints = [
            *Delivery.Meta.constraints,
            models.UniqueConstraint(
                fields=["project", "sequence"], name="event_project_sequence"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    sequence__gte=1, version=1, event_type__in=EVENT_TYPES
                ),
                name="event_version_type_sequence",
            ),
        ]
        indexes = [
            models.Index(
                fields=["available_at", "id"],
                condition=models.Q(delivered_at__isnull=True),
                name="event_pending_delivery",
            )
        ]


class InvalidationDelivery(Delivery):
    lease_ids = models.JSONField(default=list)
    session_group = models.CharField(max_length=72, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta(Delivery.Meta):
        abstract = False
        indexes = [
            models.Index(
                fields=["available_at", "id"],
                condition=models.Q(delivered_at__isnull=True),
                name="invalidation_pending_delivery",
            )
        ]

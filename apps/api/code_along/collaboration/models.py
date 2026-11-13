import uuid

from django.conf import settings
from django.contrib.postgres.functions import RandomUUID
from django.db import models
from django.db.models.functions import Now

SHA256 = r"^[a-f0-9]{64}$"
SCOPES = [("read", "Read"), ("write", "Write")]


class DocumentState(models.Model):
    document = models.OneToOneField(
        "projects.CollaborationDocument", primary_key=True, on_delete=models.PROTECT
    )
    generation = models.PositiveIntegerField()
    binary_state = models.BinaryField()
    durable_revision = models.PositiveBigIntegerField(default=0, db_default=0)
    state_sha256 = models.CharField(max_length=64)
    initialized_at = models.DateTimeField(db_default=Now())
    updated_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(generation__gte=1), name="state_generation_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(state_sha256__regex=SHA256), name="state_digest_hex"
            ),
        ]


class CheckpointReceipt(models.Model):
    id = models.UUIDField(
        primary_key=True, default=uuid.uuid4, db_default=RandomUUID(), editable=False
    )
    document = models.ForeignKey(
        "projects.CollaborationDocument", on_delete=models.PROTECT
    )
    generation = models.PositiveIntegerField()
    client_session_id = models.UUIDField()
    checkpoint_id = models.UUIDField()
    observed_counter = models.PositiveBigIntegerField()
    request_sha256 = models.CharField(max_length=64)
    durable_revision = models.PositiveBigIntegerField()
    state_sha256 = models.CharField(max_length=64)
    recorded_at = models.DateTimeField(db_default=Now())

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["document", "generation", "client_session_id", "checkpoint_id"],
                name="receipt_checkpoint_identity",
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1),
                name="receipt_generation_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(observed_counter__lte=9007199254740991),
                name="receipt_counter_safe_integer",
            ),
            models.CheckConstraint(
                condition=models.Q(durable_revision__gt=0),
                name="receipt_revision_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(request_sha256__regex=SHA256)
                & models.Q(state_sha256__regex=SHA256),
                name="receipt_digests_hex",
            ),
        ]
        indexes = [
            models.Index(
                fields=["document", "recorded_at", "id"], name="receipt_retention"
            )
        ]


class CollaborationTicket(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    session = models.ForeignKey("sessions.Session", on_delete=models.CASCADE)
    project = models.ForeignKey("projects.Project", on_delete=models.PROTECT)
    document = models.ForeignKey(
        "projects.CollaborationDocument", on_delete=models.PROTECT
    )
    generation = models.PositiveIntegerField()
    scope = models.CharField(max_length=5, choices=SCOPES)
    client_session_id = models.UUIDField()
    awareness_client_id = models.PositiveBigIntegerField()
    origin = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True, blank=True)
    consumed_connection_id = models.UUIDField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(scope__in=["read", "write"]),
                name="ticket_scope_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1)
                & models.Q(awareness_client_id__lte=4294967295),
                name="ticket_document_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="ticket_expiry_after_create",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        consumed_at__isnull=True, consumed_connection_id__isnull=True
                    )
                    | models.Q(
                        consumed_at__isnull=False, consumed_connection_id__isnull=False
                    )
                ),
                name="ticket_consumption_pair",
            ),
        ]
        indexes = [
            models.Index(fields=["expires_at"], name="ticket_expiry"),
            models.Index(
                fields=["session", "expires_at"], name="ticket_session_expiry"
            ),
        ]


class CollaborationLease(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    ticket = models.OneToOneField(CollaborationTicket, on_delete=models.RESTRICT)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    session = models.ForeignKey("sessions.Session", on_delete=models.CASCADE)
    project = models.ForeignKey("projects.Project", on_delete=models.PROTECT)
    document = models.ForeignKey(
        "projects.CollaborationDocument", on_delete=models.PROTECT
    )
    generation = models.PositiveIntegerField()
    scope = models.CharField(max_length=5, choices=SCOPES)
    connection_id = models.UUIDField(unique=True)
    transport_id = models.UUIDField()
    client_session_id = models.UUIDField()
    awareness_client_id = models.PositiveBigIntegerField()
    origin = models.CharField(max_length=255)
    workspace_acl_version = models.PositiveBigIntegerField()
    project_acl_version = models.PositiveBigIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    renewed_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(scope__in=["read", "write"]),
                name="lease_scope_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1)
                & models.Q(awareness_client_id__lte=4294967295),
                name="lease_document_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="lease_expiry_after_create",
            ),
        ]
        indexes = [
            models.Index(fields=["session", "expires_at"], name="lease_session_expiry"),
            models.Index(fields=["project", "expires_at"], name="lease_project_expiry"),
            models.Index(
                fields=["document", "generation"], name="lease_document_generation"
            ),
            models.Index(fields=["expires_at"], name="lease_expiry"),
        ]

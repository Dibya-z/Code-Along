import uuid

from django.conf import settings
from django.db import models
from django.db.models.functions import Lower


class RuntimeProfile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    runtime_id = models.CharField(max_length=100, unique=True)
    manifest = models.JSONField()
    manifest_sha256 = models.CharField(max_length=64)
    enabled = models.BooleanField(default=True)


class Project(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        "workspaces.Workspace", on_delete=models.PROTECT, related_name="projects"
    )
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="owned_projects",
    )
    name = models.CharField(max_length=120)
    entrypoint_file = models.ForeignKey(
        "ProjectFile", on_delete=models.PROTECT, related_name="entrypoint_for"
    )
    runtime_profile = models.ForeignKey(
        RuntimeProfile, on_delete=models.PROTECT, related_name="projects"
    )
    metadata_version = models.PositiveBigIntegerField(default=1)
    acl_version = models.PositiveBigIntegerField(default=1)
    event_sequence = models.PositiveBigIntegerField(default=0)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "workspace"], name="project_id_workspace_pair"
            ),
            models.CheckConstraint(
                condition=~models.Q(name__regex=r"^\s*$"), name="project_name_nonblank"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    metadata_version__gte=1, metadata_version__lte=9007199254740991
                ),
                name="project_metadata_safe_integer",
            ),
        ]


class ProjectAccess(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.PROTECT, related_name="access_grants"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="project_grants",
    )
    role = models.CharField(
        max_length=8, choices=[("editor", "Editor"), ("viewer", "Viewer")]
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["project", "user"], name="project_access_unique_user"
            ),
            models.CheckConstraint(
                condition=models.Q(role__in=["editor", "viewer"]),
                name="project_access_valid_role",
            ),
        ]


class ProjectFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(Project, on_delete=models.PROTECT, related_name="files")
    path = models.CharField(max_length=160)
    kind = models.CharField(
        max_length=8, default="python", choices=[("python", "Python")]
    )
    generation = models.PositiveIntegerField(default=1)
    initial_source = models.TextField(blank=True)
    initial_sha256 = models.CharField(max_length=64)
    deleted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["path", "id"]
        constraints = [
            models.UniqueConstraint(
                Lower("path"),
                "project",
                condition=models.Q(deleted_at__isnull=True),
                name="project_file_active_path",
            ),
            models.UniqueConstraint(
                fields=["id", "project"], name="file_id_project_pair"
            ),
            models.UniqueConstraint(
                fields=["id", "project", "generation"], name="file_parent_generation"
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1), name="file_generation_positive"
            ),
            models.CheckConstraint(
                condition=models.Q(kind="python"), name="file_kind_python"
            ),
        ]


class CollaborationDocument(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.PROTECT, related_name="documents"
    )
    file = models.OneToOneField(
        ProjectFile,
        on_delete=models.PROTECT,
        related_name="document",
        null=True,
        blank=True,
    )
    kind = models.CharField(max_length=8, default="text", choices=[("text", "Text")])
    generation = models.PositiveIntegerField(default=1)
    schema_version = models.PositiveSmallIntegerField(default=1)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["id", "generation"], name="document_id_generation_pair"
            ),
            models.UniqueConstraint(
                fields=["id", "project", "generation"],
                name="document_project_generation",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    kind="text", file__isnull=False, generation__gte=1, schema_version=1
                ),
                name="document_text_binding",
            ),
        ]


class ProjectRevision(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.PROTECT, related_name="revisions"
    )
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    author_display_name = models.CharField(max_length=80)
    client_request_id = models.UUIDField()
    name = models.CharField(max_length=120)
    provenance = models.CharField(max_length=24, default="shared_room_capture")
    manifest_version = models.PositiveSmallIntegerField(default=1)
    manifest_sha256 = models.CharField(max_length=64)
    metadata_version = models.PositiveBigIntegerField()
    entrypoint_file_id = models.UUIDField()
    runtime_profile = models.ForeignKey(RuntimeProfile, on_delete=models.PROTECT)
    runtime_identity = models.JSONField()
    runtime_manifest = models.JSONField()
    helper_release = models.JSONField()
    source_bytes = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["project", "author", "client_request_id"],
                name="revision_request_identity",
            ),
            models.UniqueConstraint(
                fields=["id", "project"], name="revision_project_pair"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    provenance="shared_room_capture", manifest_version=1
                ),
                name="revision_provenance_version",
            ),
            models.CheckConstraint(
                condition=models.Q(manifest_sha256__regex=r"^[a-f0-9]{64}$"),
                name="revision_manifest_digest",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    metadata_version__gte=1,
                    metadata_version__lte=9007199254740991,
                    source_bytes__lte=1048576,
                ),
                name="revision_source_bounds",
            ),
            models.CheckConstraint(
                condition=~models.Q(name__regex=r"^\s*$"), name="revision_name_nonblank"
            ),
        ]


class RevisionFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    revision = models.ForeignKey(
        ProjectRevision, on_delete=models.PROTECT, related_name="files"
    )
    file_id = models.UUIDField()
    document_id = models.UUIDField()
    generation = models.PositiveIntegerField()
    path = models.CharField(max_length=160)
    source = models.TextField(blank=True)
    source_sha256 = models.CharField(max_length=64)
    source_bytes = models.PositiveIntegerField()

    class Meta:
        ordering = ["path", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["revision", "file_id"], name="revision_file_identity"
            ),
            models.UniqueConstraint(
                fields=["revision", "document_id"], name="revision_document_identity"
            ),
            models.UniqueConstraint(
                fields=["revision", "path"], name="revision_file_path"
            ),
            models.CheckConstraint(
                condition=models.Q(generation__gte=1, source_bytes__lte=131072),
                name="revision_file_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(source_sha256__regex=r"^[a-f0-9]{64}$"),
                name="revision_file_digest",
            ),
        ]


class ShareGrant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        Project, on_delete=models.PROTECT, related_name="shares"
    )
    revision = models.ForeignKey(
        ProjectRevision, on_delete=models.PROTECT, null=True, blank=True
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_shares",
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="received_shares",
    )
    kind = models.CharField(
        max_length=8, choices=[("live", "Live"), ("snapshot", "Snapshot")]
    )
    scope = models.CharField(
        max_length=5, choices=[("read", "Read"), ("write", "Write")]
    )
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "project"], name="share_project_pair"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        kind="live", revision__isnull=True, scope__in=["read", "write"]
                    )
                    | models.Q(kind="snapshot", revision__isnull=False, scope="read")
                ),
                name="share_target_scope",
            ),
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("created_at")),
                name="share_expiry_after_create",
            ),
            models.CheckConstraint(
                condition=models.Q(token_digest__regex=r"^[a-f0-9]{64}$"),
                name="share_token_digest",
            ),
        ]
        indexes = [
            models.Index(fields=["project", "expires_at"], name="share_project_expiry")
        ]

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


def submission_policy(prefix: str = "") -> models.Q:
    return models.Q(**{f"{prefix}max_attempts__range": (1, 100)}) & (
        models.Q(
            **{f"{prefix}submission_mode": "individual", f"{prefix}max_team_size": 1}
        )
        | models.Q(
            **{
                f"{prefix}submission_mode": "team",
                f"{prefix}max_team_size__range": (2, 6),
            }
        )
    )


class Assignment(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    revision = models.PositiveBigIntegerField(default=1)
    published_metadata_bytes = models.PositiveBigIntegerField(default=0)
    draft_title = models.CharField(max_length=120)
    draft_instructions = models.TextField(default="", blank=True)
    draft_hints = models.JSONField(default=list)
    draft_public_checks_source = models.TextField(null=True, blank=True)
    draft_starter_project = models.ForeignKey(
        "projects.Project", on_delete=models.PROTECT, null=True, blank=True
    )
    draft_starter_revision = models.ForeignKey(
        "projects.ProjectRevision", on_delete=models.PROTECT, null=True, blank=True
    )
    draft_submission_mode = models.CharField(max_length=10, default="individual")
    draft_max_attempts = models.PositiveSmallIntegerField(default=10)
    draft_max_team_size = models.PositiveSmallIntegerField(default=1)
    draft_due_at = models.DateTimeField(null=True, blank=True)
    current_version = models.ForeignKey(
        "AssignmentVersion",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "workspace"], name="assignment_workspace_pair"
            ),
            models.CheckConstraint(
                condition=models.Q(revision__range=(1, 9007199254740991)),
                name="assignment_revision_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(published_metadata_bytes__lte=4194304),
                name="assignment_metadata_bounds",
            ),
            models.CheckConstraint(
                condition=~models.Q(draft_title=""), name="assignment_title_nonempty"
            ),
            models.CheckConstraint(
                condition=submission_policy("draft_"), name="assignment_draft_policy"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        draft_starter_project__isnull=True,
                        draft_starter_revision__isnull=True,
                    )
                    | models.Q(
                        draft_starter_project__isnull=False,
                        draft_starter_revision__isnull=False,
                    )
                ),
                name="assignment_starter_pair",
            ),
        ]
        indexes = [
            models.Index(
                fields=["workspace", "archived_at", "updated_at", "id"],
                name="assignment_workspace_list",
            )
        ]


class AssignmentVersion(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assignment = models.ForeignKey(
        Assignment, on_delete=models.PROTECT, related_name="versions"
    )
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    number = models.PositiveIntegerField()
    published_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    author_display_name = models.CharField(max_length=80)
    published_at = models.DateTimeField(default=timezone.now)
    client_request_id = models.UUIDField()
    source_revision = models.PositiveBigIntegerField()
    title = models.CharField(max_length=120)
    instructions = models.TextField()
    hints = models.JSONField()
    starter_project = models.ForeignKey("projects.Project", on_delete=models.PROTECT)
    starter_revision = models.ForeignKey(
        "projects.ProjectRevision", on_delete=models.PROTECT
    )
    starter_manifest_sha256 = models.CharField(max_length=64)
    runtime_profile = models.ForeignKey(
        "projects.RuntimeProfile", on_delete=models.PROTECT
    )
    runtime_identity = models.JSONField()
    runtime_manifest = models.JSONField()
    helper_release = models.JSONField()
    public_checks = models.JSONField(null=True, blank=True)
    submission_mode = models.CharField(max_length=10)
    max_attempts = models.PositiveSmallIntegerField()
    max_team_size = models.PositiveSmallIntegerField()
    due_at = models.DateTimeField(null=True, blank=True)
    late_policy = models.CharField(max_length=6, default="reject")
    content_sha256 = models.CharField(max_length=64)
    metadata_bytes = models.PositiveIntegerField()

    class Meta:
        ordering = ["-number", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "assignment"], name="assignment_version_parent"
            ),
            models.UniqueConstraint(
                fields=["id", "workspace"], name="assignment_version_workspace"
            ),
            models.UniqueConstraint(
                fields=["assignment", "number"], name="assignment_version_number"
            ),
            models.UniqueConstraint(
                fields=["assignment", "published_by", "client_request_id"],
                name="assignment_publish_nonce",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    number__range=(1, 50),
                    source_revision__range=(1, 9007199254740991),
                    metadata_bytes__range=(1, 262144),
                ),
                name="assignment_version_bounds",
            ),
            models.CheckConstraint(
                condition=submission_policy() & models.Q(late_policy="reject"),
                name="assignment_version_policy",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    content_sha256__regex=r"^[a-f0-9]{64}$",
                    starter_manifest_sha256__regex=r"^[a-f0-9]{64}$",
                ),
                name="assignment_version_digests",
            ),
            models.CheckConstraint(
                condition=~models.Q(title="") & ~models.Q(instructions=""),
                name="assignment_version_nonempty",
            ),
        ]
        indexes = [
            models.Index(
                fields=["assignment", "-number", "id"], name="assignment_version_list"
            )
        ]

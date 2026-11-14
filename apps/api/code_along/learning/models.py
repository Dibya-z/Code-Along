import uuid
from datetime import datetime, timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def participation_expiry() -> datetime:
    return timezone.now() + timedelta(days=7)


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
    draft_starter_scope = models.CharField(max_length=10, default="project")
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
                condition=models.Q(draft_starter_scope="project"),
                name="assignment_draft_public_scope",
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
    starter_scope = models.CharField(max_length=10, default="project")
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
                condition=models.Q(starter_scope="project"),
                name="assignment_version_public_scope",
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


class AssignmentTeam(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assignment = models.ForeignKey(
        Assignment, on_delete=models.PROTECT, related_name="teams"
    )
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_assignment_teams",
    )
    name = models.CharField(max_length=80)
    revision = models.PositiveBigIntegerField(default=1)
    roster_revision = models.PositiveBigIntegerField(default=1)
    approved_roster_revision = models.PositiveBigIntegerField(null=True, blank=True)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="approved_assignment_teams",
        null=True,
        blank=True,
    )
    approved_at = models.DateTimeField(null=True, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "assignment"], name="assignment_team_parent"
            ),
            models.UniqueConstraint(
                fields=["id", "workspace"], name="assignment_team_workspace"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    revision__range=(1, 9007199254740991),
                    roster_revision__range=(1, 9007199254740991),
                ),
                name="assignment_team_revision_bounds",
            ),
            models.CheckConstraint(
                condition=~models.Q(name=""), name="assignment_team_name_nonempty"
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        approved_roster_revision__isnull=True,
                        approved_by__isnull=True,
                        approved_at__isnull=True,
                    )
                    | models.Q(
                        approved_roster_revision__isnull=False,
                        approved_roster_revision__range=(1, 9007199254740991),
                        approved_roster_revision__lte=models.F("roster_revision"),
                        approved_by__isnull=False,
                        approved_at__isnull=False,
                    )
                ),
                name="assignment_team_approval_pair",
            ),
        ]
        indexes = [
            models.Index(
                fields=["assignment", "archived_at", "id"], name="assignment_team_list"
            )
        ]


class AssignmentParticipation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assignment = models.ForeignKey(
        Assignment, on_delete=models.PROTECT, related_name="participations"
    )
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="assignment_participations",
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="offered_assignment_participations",
    )
    state = models.CharField(max_length=10, default="invited")
    revision = models.PositiveBigIntegerField(default=1)
    invited_at = models.DateTimeField(default=timezone.now)
    invite_expires_at = models.DateTimeField(default=participation_expiry)
    accepted_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    team = models.ForeignKey(
        AssignmentTeam,
        on_delete=models.PROTECT,
        related_name="participations",
        null=True,
        blank=True,
    )
    team_offer_expires_at = models.DateTimeField(null=True, blank=True)
    team_consent_revision = models.PositiveBigIntegerField(null=True, blank=True)
    team_consented_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["invited_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["assignment", "user"], name="assignment_participation_user"
            ),
            models.UniqueConstraint(
                fields=["id", "assignment"], name="assignment_participation_parent"
            ),
            models.UniqueConstraint(
                fields=["id", "workspace"], name="assignment_participation_space"
            ),
            models.UniqueConstraint(
                fields=["id", "assignment", "user"],
                name="assignment_participation_identity",
            ),
            models.CheckConstraint(
                condition=models.Q(revision__range=(1, 9007199254740991)),
                name="participation_revision_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    state__in=[
                        "invited",
                        "accepted",
                        "declined",
                        "withdrawn",
                        "revoked",
                    ]
                ),
                name="participation_valid_state",
            ),
            models.CheckConstraint(
                condition=~models.Q(state="accepted")
                | models.Q(accepted_at__isnull=False),
                name="participation_accepted_time",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(state__in=["invited", "accepted"], ended_at__isnull=True)
                    | models.Q(
                        state__in=["declined", "withdrawn", "revoked"],
                        ended_at__isnull=False,
                    )
                ),
                name="participation_ended_pair",
            ),
            models.CheckConstraint(
                condition=models.Q(invite_expires_at__gt=models.F("invited_at")),
                name="participation_offer_lifetime",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        team__isnull=True,
                        team_offer_expires_at__isnull=True,
                        team_consent_revision__isnull=True,
                        team_consented_at__isnull=True,
                    )
                    | models.Q(
                        team__isnull=False,
                        team_offer_expires_at__isnull=False,
                        state="accepted",
                    )
                ),
                name="participation_team_offer_pair",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        team_consent_revision__isnull=True,
                        team_consented_at__isnull=True,
                    )
                    | models.Q(
                        team_consent_revision__isnull=False,
                        team_consent_revision__range=(1, 9007199254740991),
                        team_consented_at__isnull=False,
                    )
                ),
                name="participation_team_consent_pair",
            ),
        ]
        indexes = [
            models.Index(
                fields=["user", "state", "updated_at", "id"],
                name="participation_user_list",
            ),
            models.Index(
                fields=["assignment", "state", "id"],
                name="participation_assignment_list",
            ),
        ]


class AssignmentWork(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assignment = models.ForeignKey(
        Assignment, on_delete=models.PROTECT, related_name="works"
    )
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    assignment_version = models.ForeignKey(
        AssignmentVersion, on_delete=models.PROTECT, related_name="works"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_assignment_work",
    )
    subject_kind = models.CharField(max_length=10)
    participation = models.ForeignKey(
        AssignmentParticipation,
        on_delete=models.PROTECT,
        related_name="works",
        null=True,
        blank=True,
    )
    team = models.ForeignKey(
        AssignmentTeam,
        on_delete=models.PROTECT,
        related_name="works",
        null=True,
        blank=True,
    )
    team_roster_revision = models.PositiveBigIntegerField(null=True, blank=True)
    project = models.OneToOneField(
        "projects.Project", on_delete=models.PROTECT, related_name="assignment_work"
    )
    client_request_id = models.UUIDField()
    request_sha256 = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)
    state = models.CharField(max_length=7, default="active")
    retired_at = models.DateTimeField(null=True, blank=True)
    retired_reason = models.CharField(max_length=20, null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["id", "assignment"], name="assignment_work_parent"
            ),
            models.UniqueConstraint(
                fields=[
                    "id",
                    "assignment",
                    "workspace",
                    "assignment_version",
                    "project",
                ],
                name="work_submission_parent",
            ),
            models.UniqueConstraint(
                fields=["assignment", "created_by", "client_request_id"],
                name="assignment_work_nonce",
            ),
            models.UniqueConstraint(
                fields=["assignment_version", "participation"],
                condition=models.Q(state="active", subject_kind="individual"),
                name="assignment_work_active_person",
            ),
            models.UniqueConstraint(
                fields=["assignment_version", "team", "team_roster_revision"],
                condition=models.Q(state="active", subject_kind="team"),
                name="assignment_work_active_team",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        subject_kind="individual",
                        participation__isnull=False,
                        team__isnull=True,
                        team_roster_revision__isnull=True,
                    )
                    | models.Q(
                        subject_kind="team",
                        participation__isnull=True,
                        team__isnull=False,
                        team_roster_revision__isnull=False,
                        team_roster_revision__range=(1, 9007199254740991),
                    )
                ),
                name="assignment_work_subject_pair",
            ),
            models.CheckConstraint(
                condition=models.Q(request_sha256__regex=r"^[a-f0-9]{64}$"),
                name="assignment_work_digest",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(
                        state="active",
                        retired_at__isnull=True,
                        retired_reason__isnull=True,
                    )
                    | models.Q(
                        state="retired",
                        retired_at__isnull=False,
                        retired_reason__isnull=False,
                        retired_reason__in=[
                            "participation_ended",
                            "roster_changed",
                            "team_archived",
                            "project_unavailable",
                        ],
                    )
                ),
                name="assignment_work_retirement",
            ),
        ]
        indexes = [
            models.Index(
                fields=["assignment", "state", "created_at", "id"],
                name="assignment_work_list",
            )
        ]


class AssignmentWorkMember(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    work = models.ForeignKey(
        AssignmentWork, on_delete=models.PROTECT, related_name="members"
    )
    assignment = models.ForeignKey(Assignment, on_delete=models.PROTECT)
    participation = models.ForeignKey(AssignmentParticipation, on_delete=models.PROTECT)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="assignment_work_memberships",
    )
    display_name = models.CharField(max_length=80)
    participation_revision = models.PositiveBigIntegerField()
    consent_roster_revision = models.PositiveBigIntegerField(null=True, blank=True)
    source_role_at_creation = models.CharField(max_length=6)

    class Meta:
        ordering = ["id"]
        constraints = [
            models.UniqueConstraint(
                fields=["work", "user"], name="assignment_work_member_user"
            ),
            models.UniqueConstraint(
                fields=["work", "participation"], name="assignment_work_member_person"
            ),
            models.CheckConstraint(
                condition=models.Q(participation_revision__range=(1, 9007199254740991)),
                name="work_member_revision_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(consent_roster_revision__isnull=True)
                | models.Q(consent_roster_revision__range=(1, 9007199254740991)),
                name="work_member_consent_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(source_role_at_creation__in=["owner", "editor"]),
                name="work_member_source_role",
            ),
            models.CheckConstraint(
                condition=~models.Q(display_name=""), name="work_member_name_nonempty"
            ),
        ]

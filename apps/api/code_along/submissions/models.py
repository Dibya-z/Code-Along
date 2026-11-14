"""Private immutable learning records; live source grants confer no authority."""

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class Submission(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assignment = models.ForeignKey("learning.Assignment", on_delete=models.PROTECT)
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    work = models.ForeignKey("learning.AssignmentWork", on_delete=models.PROTECT)
    assignment_version = models.ForeignKey(
        "learning.AssignmentVersion", on_delete=models.PROTECT
    )
    project = models.ForeignKey("projects.Project", on_delete=models.PROTECT)
    revision = models.OneToOneField(
        "projects.ProjectRevision", on_delete=models.PROTECT
    )
    artifact_scope = models.CharField(max_length=10, default="submission")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    author_display_name = models.CharField(max_length=80)
    client_request_id = models.UUIDField()
    request_sha256 = models.CharField(max_length=64)
    source_manifest_sha256 = models.CharField(max_length=64)
    stdin_mode = models.CharField(max_length=11)
    practice = models.JSONField(null=True, blank=True)
    assignment_submission_number = models.PositiveIntegerField()
    subject_attempt_number = models.PositiveSmallIntegerField()
    team = models.ForeignKey(
        "learning.AssignmentTeam", on_delete=models.PROTECT, null=True, blank=True
    )
    team_roster_revision = models.PositiveBigIntegerField(null=True, blank=True)
    submitted_at = models.DateTimeField(default=timezone.now)
    metadata_bytes = models.PositiveIntegerField()
    participant_count = models.PositiveSmallIntegerField()

    class Meta:
        ordering = ["-assignment_submission_number", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["assignment", "author", "client_request_id"],
                name="submission_actor_nonce",
            ),
            models.UniqueConstraint(
                fields=["assignment", "assignment_submission_number"],
                name="submission_assignment_number",
            ),
            models.UniqueConstraint(
                fields=["id", "assignment", "assignment_version"],
                name="submission_version_parent",
            ),
            models.UniqueConstraint(
                fields=["assignment_version", "team", "subject_attempt_number"],
                condition=models.Q(team__isnull=False),
                name="submission_team_attempt",
            ),
            models.CheckConstraint(
                condition=models.Q(artifact_scope="submission"),
                name="submission_private_scope",
            ),
            models.CheckConstraint(
                condition=models.Q(stdin_mode__in=["batch", "interactive"]),
                name="submission_input_mode",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    assignment_submission_number__range=(1, 256),
                    subject_attempt_number__range=(1, 256),
                    metadata_bytes__range=(1, 16384),
                    participant_count__range=(1, 6),
                ),
                name="submission_record_bounds",
            ),
            models.CheckConstraint(
                condition=models.Q(
                    request_sha256__regex=r"^[a-f0-9]{64}$",
                    source_manifest_sha256__regex=r"^[a-f0-9]{64}$",
                ),
                name="submission_digests",
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(team__isnull=True, team_roster_revision__isnull=True)
                    | models.Q(
                        team__isnull=False,
                        team_roster_revision__isnull=False,
                        team_roster_revision__gte=1,
                    )
                ),
                name="submission_team_pair",
            ),
        ]
        indexes = [
            models.Index(
                fields=["work", "assignment_submission_number"],
                name="submission_work_number",
            )
        ]


class SubmissionParticipant(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    submission = models.ForeignKey(
        Submission, on_delete=models.PROTECT, related_name="participants"
    )
    assignment = models.ForeignKey("learning.Assignment", on_delete=models.PROTECT)
    assignment_version = models.ForeignKey(
        "learning.AssignmentVersion", on_delete=models.PROTECT
    )
    participation = models.ForeignKey(
        "learning.AssignmentParticipation", on_delete=models.PROTECT
    )
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    display_name = models.CharField(max_length=80)
    attempt_number = models.PositiveSmallIntegerField()

    class Meta:
        ordering = ["user_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["submission", "user"], name="submission_participant_user"
            ),
            models.UniqueConstraint(
                fields=["assignment_version", "user", "attempt_number"],
                name="submission_person_attempt",
            ),
            models.CheckConstraint(
                condition=models.Q(attempt_number__range=(1, 100)),
                name="submission_attempt_bounds",
            ),
        ]


class SubmissionAssignmentUsage(models.Model):
    assignment = models.OneToOneField(
        "learning.Assignment", on_delete=models.PROTECT, primary_key=True
    )
    workspace = models.ForeignKey("workspaces.Workspace", on_delete=models.PROTECT)
    count = models.PositiveIntegerField(default=0)
    source_bytes = models.PositiveBigIntegerField(default=0)
    metadata_bytes = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    count__lte=256,
                    source_bytes__lte=33554432,
                    metadata_bytes__lte=4194304,
                ),
                name="submission_assignment_capacity",
            )
        ]


class SubmissionWorkspaceUsage(models.Model):
    workspace = models.OneToOneField(
        "workspaces.Workspace", on_delete=models.PROTECT, primary_key=True
    )
    count = models.PositiveIntegerField(default=0)
    source_bytes = models.PositiveBigIntegerField(default=0)
    metadata_bytes = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(
                    count__lte=1024,
                    source_bytes__lte=134217728,
                    metadata_bytes__lte=16777216,
                ),
                name="submission_workspace_capacity",
            )
        ]

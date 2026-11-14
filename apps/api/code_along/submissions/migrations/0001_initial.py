import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
from django.db.migrations.exceptions import IrreversibleError


def refuse_private_reversal(apps, schema_editor):
    if (
        apps.get_model("submissions", "Submission")
        .objects.using(schema_editor.connection.alias)
        .exists()
        or apps.get_model("projects", "ProjectRevision")
        .objects.using(schema_editor.connection.alias)
        .exclude(
            artifact_scope="project",
            provenance="shared_room_capture",
            manifest_version=1,
        )
        .exists()
    ):
        raise IrreversibleError(
            "Retained private submissions require their authorization schema."
        )


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("learning", "0005_starter_artifact_scope"),
        ("projects", "0010_revision_artifact_scope"),
        ("workspaces", "0004_project_invitation_parent"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Submission",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "artifact_scope",
                    models.CharField(default="submission", max_length=10),
                ),
                ("author_display_name", models.CharField(max_length=80)),
                ("client_request_id", models.UUIDField()),
                ("request_sha256", models.CharField(max_length=64)),
                ("source_manifest_sha256", models.CharField(max_length=64)),
                ("stdin_mode", models.CharField(max_length=11)),
                ("practice", models.JSONField(blank=True, null=True)),
                ("assignment_submission_number", models.PositiveIntegerField()),
                ("subject_attempt_number", models.PositiveSmallIntegerField()),
                (
                    "team_roster_revision",
                    models.PositiveBigIntegerField(blank=True, null=True),
                ),
                (
                    "submitted_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("metadata_bytes", models.PositiveIntegerField()),
                ("participant_count", models.PositiveSmallIntegerField()),
                (
                    "assignment",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignment",
                    ),
                ),
                (
                    "assignment_version",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentversion",
                    ),
                ),
                (
                    "author",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="projects.project",
                    ),
                ),
                (
                    "revision",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="projects.projectrevision",
                    ),
                ),
                (
                    "team",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentteam",
                    ),
                ),
                (
                    "work",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentwork",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
            options={
                "ordering": ["-assignment_submission_number", "id"],
            },
        ),
        migrations.CreateModel(
            name="SubmissionAssignmentUsage",
            fields=[
                (
                    "assignment",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        primary_key=True,
                        serialize=False,
                        to="learning.assignment",
                    ),
                ),
                ("count", models.PositiveIntegerField(default=0)),
                ("source_bytes", models.PositiveBigIntegerField(default=0)),
                ("metadata_bytes", models.PositiveBigIntegerField(default=0)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="workspaces.workspace",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="SubmissionParticipant",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("display_name", models.CharField(max_length=80)),
                ("attempt_number", models.PositiveSmallIntegerField()),
                (
                    "assignment",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignment",
                    ),
                ),
                (
                    "assignment_version",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentversion",
                    ),
                ),
                (
                    "participation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentparticipation",
                    ),
                ),
                (
                    "submission",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="participants",
                        to="submissions.submission",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["user_id"],
            },
        ),
        migrations.CreateModel(
            name="SubmissionWorkspaceUsage",
            fields=[
                (
                    "workspace",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        primary_key=True,
                        serialize=False,
                        to="workspaces.workspace",
                    ),
                ),
                ("count", models.PositiveIntegerField(default=0)),
                ("source_bytes", models.PositiveBigIntegerField(default=0)),
                ("metadata_bytes", models.PositiveBigIntegerField(default=0)),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(
                            ("count__lte", 1024),
                            ("metadata_bytes__lte", 16777216),
                            ("source_bytes__lte", 134217728),
                        ),
                        name="submission_workspace_capacity",
                    )
                ],
            },
        ),
        migrations.AddIndex(
            model_name="submission",
            index=models.Index(
                fields=["work", "assignment_submission_number"],
                name="submission_work_number",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.UniqueConstraint(
                fields=("assignment", "author", "client_request_id"),
                name="submission_actor_nonce",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.UniqueConstraint(
                fields=("assignment", "assignment_submission_number"),
                name="submission_assignment_number",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.UniqueConstraint(
                fields=("id", "assignment", "assignment_version"),
                name="submission_version_parent",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.UniqueConstraint(
                condition=models.Q(("team__isnull", False)),
                fields=("assignment_version", "team", "subject_attempt_number"),
                name="submission_team_attempt",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.CheckConstraint(
                condition=models.Q(("artifact_scope", "submission")),
                name="submission_private_scope",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.CheckConstraint(
                condition=models.Q(("stdin_mode__in", ["batch", "interactive"])),
                name="submission_input_mode",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("assignment_submission_number__range", (1, 256)),
                    ("metadata_bytes__range", (1, 16384)),
                    ("participant_count__range", (1, 6)),
                    ("subject_attempt_number__range", (1, 256)),
                ),
                name="submission_record_bounds",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("request_sha256__regex", "^[a-f0-9]{64}$"),
                    ("source_manifest_sha256__regex", "^[a-f0-9]{64}$"),
                ),
                name="submission_digests",
            ),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("team__isnull", True), ("team_roster_revision__isnull", True)
                    ),
                    models.Q(
                        ("team__isnull", False),
                        ("team_roster_revision__gte", 1),
                        ("team_roster_revision__isnull", False),
                    ),
                    _connector="OR",
                ),
                name="submission_team_pair",
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionassignmentusage",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("count__lte", 256),
                    ("metadata_bytes__lte", 4194304),
                    ("source_bytes__lte", 33554432),
                ),
                name="submission_assignment_capacity",
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionparticipant",
            constraint=models.UniqueConstraint(
                fields=("submission", "user"), name="submission_participant_user"
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionparticipant",
            constraint=models.UniqueConstraint(
                fields=("assignment_version", "user", "attempt_number"),
                name="submission_person_attempt",
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionparticipant",
            constraint=models.CheckConstraint(
                condition=models.Q(("attempt_number__range", (1, 100))),
                name="submission_attempt_bounds",
            ),
        ),
        migrations.RunPython(migrations.RunPython.noop, refuse_private_reversal),
    ]

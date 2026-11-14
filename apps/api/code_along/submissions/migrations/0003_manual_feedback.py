import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
from django.db.migrations.exceptions import IrreversibleError

FORWARD = """
ALTER TABLE public.submissions_instructorfeedback ADD CONSTRAINT feedback_submission_scope
 FOREIGN KEY(submission_id,assignment_id,workspace_id) REFERENCES public.submissions_submission(id,assignment_id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_feedbackpublication ADD CONSTRAINT feedback_publication_scope
 FOREIGN KEY(feedback_id,submission_id,assignment_id,workspace_id) REFERENCES public.submissions_instructorfeedback(id,submission_id,assignment_id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_instructorfeedback ADD CONSTRAINT feedback_current_publication
 FOREIGN KEY(current_publication_id,id) REFERENCES public.submissions_feedbackpublication(id,feedback_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_instructorfeedback ADD CONSTRAINT feedback_draft_text_bytes CHECK(octet_length(draft_comments)<=8192);
ALTER TABLE public.submissions_feedbackpublication ADD CONSTRAINT feedback_publication_text_bytes CHECK(octet_length(comments)<=8192 AND octet_length(publisher_display_name)<=320);
CREATE FUNCTION public.feedback_guard_draft() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Feedback draft identity cannot change.' USING ERRCODE='check_violation', CONSTRAINT='feedback_identity_immutable'; END IF;
 IF ROW(NEW.id,NEW.submission_id,NEW.assignment_id,NEW.workspace_id) IS DISTINCT FROM ROW(OLD.id,OLD.submission_id,OLD.assignment_id,OLD.workspace_id) THEN
 RAISE EXCEPTION 'Feedback draft identity cannot change.' USING ERRCODE='check_violation', CONSTRAINT='feedback_identity_immutable'; END IF;
 IF NEW.revision<>OLD.revision+1 OR NEW.published_metadata_bytes<OLD.published_metadata_bytes THEN
 RAISE EXCEPTION 'Feedback draft revision must advance exactly once.' USING ERRCODE='check_violation', CONSTRAINT='feedback_revision_advance'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_feedback_draft BEFORE UPDATE OR DELETE ON public.submissions_instructorfeedback FOR EACH ROW EXECUTE FUNCTION public.feedback_guard_draft();
CREATE FUNCTION public.feedback_reject_publication_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Manual feedback publications are immutable.' USING ERRCODE='check_violation', CONSTRAINT='feedback_publication_immutable'; END;
$$;
CREATE TRIGGER immutable_feedback_publication BEFORE UPDATE OR DELETE ON public.submissions_feedbackpublication FOR EACH ROW EXECUTE FUNCTION public.feedback_reject_publication_change();
"""

REVERSE = """
DROP TRIGGER immutable_feedback_publication ON public.submissions_feedbackpublication;
DROP FUNCTION public.feedback_reject_publication_change();
DROP TRIGGER guarded_feedback_draft ON public.submissions_instructorfeedback;
DROP FUNCTION public.feedback_guard_draft();
ALTER TABLE public.submissions_feedbackpublication DROP CONSTRAINT feedback_publication_text_bytes;
ALTER TABLE public.submissions_instructorfeedback DROP CONSTRAINT feedback_draft_text_bytes;
ALTER TABLE public.submissions_instructorfeedback DROP CONSTRAINT feedback_current_publication;
ALTER TABLE public.submissions_feedbackpublication DROP CONSTRAINT feedback_publication_scope;
ALTER TABLE public.submissions_instructorfeedback DROP CONSTRAINT feedback_submission_scope;
"""


def refuse_private_reversal(apps, schema_editor):
    alias = schema_editor.connection.alias
    private = (
        apps.get_model("projects", "ProjectRevision")
        .objects.using(alias)
        .exclude(
            artifact_scope="project",
            provenance="shared_room_capture",
            manifest_version=1,
        )
        .exists()
    )
    if private or any(
        apps.get_model("submissions", name).objects.using(alias).exists()
        for name in ("Submission", "InstructorFeedback", "FeedbackPublication")
    ):
        raise IrreversibleError(
            "Retained private submissions or feedback require their authorization schema."
        )


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0005_starter_artifact_scope"),
        ("projects", "0010_revision_artifact_scope"),
        ("submissions", "0002_submission_integrity"),
        ("workspaces", "0004_project_invitation_parent"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="FeedbackPublication",
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
                ("number", models.PositiveSmallIntegerField()),
                ("source_revision", models.PositiveBigIntegerField()),
                ("publisher_display_name", models.CharField(max_length=80)),
                (
                    "published_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("client_request_id", models.UUIDField()),
                ("request_sha256", models.CharField(max_length=64)),
                ("comments", models.TextField(blank=True)),
                ("assessment_status", models.CharField(max_length=13)),
                ("content_sha256", models.CharField(max_length=64)),
                ("metadata_bytes", models.PositiveIntegerField()),
            ],
            options={
                "ordering": ["-number", "id"],
            },
        ),
        migrations.CreateModel(
            name="InstructorFeedback",
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
                ("revision", models.PositiveBigIntegerField(default=1)),
                ("draft_comments", models.TextField(blank=True, default="")),
                (
                    "draft_assessment_status",
                    models.CharField(blank=True, max_length=13, null=True),
                ),
                ("updated_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("published_metadata_bytes", models.PositiveBigIntegerField(default=0)),
            ],
        ),
        migrations.RemoveConstraint(
            model_name="submissionassignmentusage",
            name="submission_assignment_capacity",
        ),
        migrations.RemoveConstraint(
            model_name="submissionworkspaceusage",
            name="submission_workspace_capacity",
        ),
        migrations.AddField(
            model_name="submissionassignmentusage",
            name="feedback_metadata_bytes",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="submissionworkspaceusage",
            name="feedback_metadata_bytes",
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddConstraint(
            model_name="submission",
            constraint=models.UniqueConstraint(
                fields=("id", "assignment", "workspace"),
                name="submission_review_parent",
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionassignmentusage",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("count__lte", 256),
                    ("feedback_metadata_bytes__lte", 8388608),
                    ("metadata_bytes__lte", 4194304),
                    ("source_bytes__lte", 33554432),
                ),
                name="submission_assignment_capacity",
            ),
        ),
        migrations.AddConstraint(
            model_name="submissionworkspaceusage",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("count__lte", 1024),
                    ("feedback_metadata_bytes__lte", 33554432),
                    ("metadata_bytes__lte", 16777216),
                    ("source_bytes__lte", 134217728),
                ),
                name="submission_workspace_capacity",
            ),
        ),
        migrations.AddField(
            model_name="feedbackpublication",
            name="assignment",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to="learning.assignment"
            ),
        ),
        migrations.AddField(
            model_name="feedbackpublication",
            name="published_by",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL
            ),
        ),
        migrations.AddField(
            model_name="feedbackpublication",
            name="submission",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to="submissions.submission"
            ),
        ),
        migrations.AddField(
            model_name="feedbackpublication",
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to="workspaces.workspace"
            ),
        ),
        migrations.AddField(
            model_name="instructorfeedback",
            name="assignment",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to="learning.assignment"
            ),
        ),
        migrations.AddField(
            model_name="instructorfeedback",
            name="current_publication",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="submissions.feedbackpublication",
            ),
        ),
        migrations.AddField(
            model_name="instructorfeedback",
            name="last_edited_by",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL
            ),
        ),
        migrations.AddField(
            model_name="instructorfeedback",
            name="submission",
            field=models.OneToOneField(
                on_delete=django.db.models.deletion.PROTECT, to="submissions.submission"
            ),
        ),
        migrations.AddField(
            model_name="instructorfeedback",
            name="workspace",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, to="workspaces.workspace"
            ),
        ),
        migrations.AddField(
            model_name="feedbackpublication",
            name="feedback",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="publications",
                to="submissions.instructorfeedback",
            ),
        ),
        migrations.AddConstraint(
            model_name="instructorfeedback",
            constraint=models.UniqueConstraint(
                fields=("id", "submission", "assignment", "workspace"),
                name="feedback_scoped_parent",
            ),
        ),
        migrations.AddConstraint(
            model_name="instructorfeedback",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("published_metadata_bytes__lte", 131072),
                    ("revision__range", (1, 9007199254740991)),
                ),
                name="feedback_draft_bounds",
            ),
        ),
        migrations.AddConstraint(
            model_name="instructorfeedback",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("draft_assessment_status__isnull", True),
                    (
                        "draft_assessment_status__in",
                        ["reviewed", "needs_changes", "complete"],
                    ),
                    _connector="OR",
                ),
                name="feedback_draft_status",
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.UniqueConstraint(
                fields=("feedback", "number"), name="feedback_publication_number"
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.UniqueConstraint(
                fields=("feedback", "published_by", "client_request_id"),
                name="feedback_publication_nonce",
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.UniqueConstraint(
                fields=("id", "feedback"), name="feedback_publication_parent"
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("metadata_bytes__range", (1, 16384)),
                    ("number__range", (1, 20)),
                    ("source_revision__range", (1, 9007199254740991)),
                ),
                name="feedback_publication_bounds",
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("assessment_status__in", ["reviewed", "needs_changes", "complete"])
                ),
                name="feedback_publication_status",
            ),
        ),
        migrations.AddConstraint(
            model_name="feedbackpublication",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("content_sha256__regex", "^[a-f0-9]{64}$"),
                    ("request_sha256__regex", "^[a-f0-9]{64}$"),
                ),
                name="feedback_publication_digests",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunPython(migrations.RunPython.noop, refuse_private_reversal),
    ]

import uuid

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
from django.db.migrations.exceptions import IrreversibleError

FORWARD = """
ALTER TABLE public.learning_learningnotificationstream ADD CONSTRAINT learning_stream_assignment_scope
 FOREIGN KEY(assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_learningnotificationstream ADD CONSTRAINT learning_stream_participation_scope
 FOREIGN KEY(participation_id,assignment_id,audience_user_id) REFERENCES public.learning_assignmentparticipation(id,assignment_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.learning_guard_stream() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Learning stream identities are retained.' USING ERRCODE='check_violation',CONSTRAINT='learning_stream_identity_immutable'; END IF;
 IF ROW(NEW.id,NEW.assignment_id,NEW.workspace_id,NEW.audience_user_id,NEW.participation_id) IS DISTINCT FROM ROW(OLD.id,OLD.assignment_id,OLD.workspace_id,OLD.audience_user_id,OLD.participation_id) THEN
 RAISE EXCEPTION 'Learning stream identity cannot change.' USING ERRCODE='check_violation',CONSTRAINT='learning_stream_identity_immutable'; END IF;
 IF NEW.head_generation<OLD.head_generation OR NEW.head_generation::numeric>OLD.head_generation::numeric+1 OR NEW.published_generation<OLD.published_generation THEN
 RAISE EXCEPTION 'Learning generations cannot rewind or skip domain increments.' USING ERRCODE='check_violation',CONSTRAINT='learning_stream_monotonic'; END IF;
 IF OLD.claim_generation IS NOT NULL AND NEW.claim_generation IS NOT NULL AND OLD.claim_generation<>NEW.claim_generation THEN
 RAISE EXCEPTION 'Captured learning generation is stable until acknowledgement.' USING ERRCODE='check_violation',CONSTRAINT='learning_stream_stable_capture'; END IF;
 IF OLD.claim_generation IS NOT NULL AND NEW.claim_generation IS NULL AND NEW.published_generation<OLD.claim_generation THEN
 RAISE EXCEPTION 'Captured learning generation requires acknowledgement.' USING ERRCODE='check_violation',CONSTRAINT='learning_stream_capture_ack'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_learning_stream BEFORE UPDATE OR DELETE ON public.learning_learningnotificationstream FOR EACH ROW EXECUTE FUNCTION public.learning_guard_stream();
"""

REVERSE = """
DROP TRIGGER guarded_learning_stream ON public.learning_learningnotificationstream;
DROP FUNCTION public.learning_guard_stream();
ALTER TABLE public.learning_learningnotificationstream DROP CONSTRAINT learning_stream_participation_scope;
ALTER TABLE public.learning_learningnotificationstream DROP CONSTRAINT learning_stream_assignment_scope;
"""


def backfill_streams(apps, schema_editor):
    alias = schema_editor.connection.alias
    Stream = apps.get_model("learning", "LearningNotificationStream")
    Assignment = apps.get_model("learning", "Assignment")
    Participation = apps.get_model("learning", "AssignmentParticipation")
    batch = []
    for identifier, workspace_id in (
        Assignment.objects.using(alias)
        .order_by("id")
        .values_list("id", "workspace_id")
        .iterator(chunk_size=200)
    ):
        batch.append(Stream(assignment_id=identifier, workspace_id=workspace_id))
        if len(batch) == 200:
            Stream.objects.using(alias).bulk_create(
                batch, ignore_conflicts=True, batch_size=200
            )
            batch = []
    if batch:
        Stream.objects.using(alias).bulk_create(
            batch, ignore_conflicts=True, batch_size=200
        )
    batch = []
    for identifier, assignment_id, workspace_id, user_id in (
        Participation.objects.using(alias)
        .order_by("id")
        .values_list("id", "assignment_id", "workspace_id", "user_id")
        .iterator(chunk_size=200)
    ):
        batch.append(
            Stream(
                assignment_id=assignment_id,
                workspace_id=workspace_id,
                audience_user_id=user_id,
                participation_id=identifier,
            )
        )
        if len(batch) == 200:
            Stream.objects.using(alias).bulk_create(
                batch, ignore_conflicts=True, batch_size=200
            )
            batch = []
    if batch:
        Stream.objects.using(alias).bulk_create(
            batch, ignore_conflicts=True, batch_size=200
        )


def refuse_private_reversal(apps, schema_editor):
    if (
        apps.get_model("projects", "ProjectRevision")
        .objects.using(schema_editor.connection.alias)
        .exclude(
            artifact_scope="project",
            provenance="shared_room_capture",
            manifest_version=1,
        )
        .exists()
    ):
        raise IrreversibleError(
            "Retained private submissions require their learning authority boundaries."
        )


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0005_starter_artifact_scope"),
        ("workspaces", "0004_project_invitation_parent"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="LearningNotificationStream",
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
                ("head_generation", models.PositiveBigIntegerField(default=0)),
                ("published_generation", models.PositiveBigIntegerField(default=0)),
                ("updated_at", models.DateTimeField(default=django.utils.timezone.now)),
                (
                    "available_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("attempts", models.PositiveIntegerField(default=0)),
                ("lock_token", models.UUIDField(blank=True, null=True)),
                ("locked_until", models.DateTimeField(blank=True, null=True)),
                (
                    "claim_generation",
                    models.PositiveBigIntegerField(blank=True, null=True),
                ),
                (
                    "last_error_code",
                    models.CharField(blank=True, default="", max_length=32),
                ),
                (
                    "assignment",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignment",
                    ),
                ),
                (
                    "audience_user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "participation",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        to="learning.assignmentparticipation",
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
                "indexes": [
                    models.Index(
                        condition=models.Q(
                            ("head_generation__gt", models.F("published_generation"))
                        ),
                        fields=["available_at", "id"],
                        name="learning_stream_pending",
                    )
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("assignment", "audience_user"),
                        name="learning_stream_audience",
                        nulls_distinct=False,
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("audience_user__isnull", True),
                                ("participation__isnull", True),
                            ),
                            models.Q(
                                ("audience_user__isnull", False),
                                ("participation__isnull", False),
                            ),
                            _connector="OR",
                        ),
                        name="learning_stream_audience_pair",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("attempts__lte", 1000000),
                            ("head_generation__lte", 9223372036854775807),
                            ("published_generation__lte", models.F("head_generation")),
                        ),
                        name="learning_stream_generation_bounds",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("lock_token__isnull", True),
                                ("locked_until__isnull", True),
                            ),
                            models.Q(
                                ("claim_generation__isnull", False),
                                ("lock_token__isnull", False),
                                ("locked_until__isnull", False),
                            ),
                            _connector="OR",
                        ),
                        name="learning_stream_lock_pair",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            ("claim_generation__isnull", True),
                            models.Q(
                                (
                                    "claim_generation__gt",
                                    models.F("published_generation"),
                                ),
                                ("claim_generation__lte", models.F("head_generation")),
                            ),
                            _connector="OR",
                        ),
                        name="learning_stream_capture_bounds",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            models.Q(
                                ("head_generation", models.F("published_generation")),
                                _negated=True,
                            ),
                            models.Q(
                                ("claim_generation__isnull", True),
                                ("lock_token__isnull", True),
                                ("locked_until__isnull", True),
                            ),
                            _connector="OR",
                        ),
                        name="learning_stream_clean_claim",
                    ),
                    models.CheckConstraint(
                        condition=models.Q(
                            (
                                "last_error_code__in",
                                [
                                    "",
                                    "channel_unavailable",
                                    "invalid_delivery",
                                    "projection_failed",
                                ],
                            )
                        ),
                        name="learning_stream_error_code",
                    ),
                ],
            },
        ),
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunPython(backfill_streams, migrations.RunPython.noop),
        # CreateModel's ordinary foreign-key DDL is deferred until the schema
        # editor exits. Drain backfill FK events before that later ALTER TABLE.
        migrations.RunSQL("SET CONSTRAINTS ALL IMMEDIATE", migrations.RunSQL.noop),
        migrations.RunPython(migrations.RunPython.noop, refuse_private_reversal),
    ]

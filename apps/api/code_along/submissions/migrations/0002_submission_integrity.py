from django.db import migrations
from django.db.migrations.exceptions import IrreversibleError

FORWARD = """
ALTER TABLE public.submissions_submission ADD CONSTRAINT submission_work_binding
 FOREIGN KEY(work_id,assignment_id,workspace_id,assignment_version_id,project_id)
 REFERENCES public.learning_assignmentwork(id,assignment_id,workspace_id,assignment_version_id,project_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submission ADD CONSTRAINT submission_revision_binding
 FOREIGN KEY(revision_id,project_id,artifact_scope)
 REFERENCES public.projects_projectrevision(id,project_id,artifact_scope) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submission ADD CONSTRAINT submission_team_binding
 FOREIGN KEY(team_id,assignment_id) REFERENCES public.learning_assignmentteam(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submissionparticipant ADD CONSTRAINT submission_participant_parent
 FOREIGN KEY(submission_id,assignment_id,assignment_version_id)
 REFERENCES public.submissions_submission(id,assignment_id,assignment_version_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submissionparticipant ADD CONSTRAINT submission_participation_identity
 FOREIGN KEY(participation_id,assignment_id,user_id)
 REFERENCES public.learning_assignmentparticipation(id,assignment_id,user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submissionassignmentusage ADD CONSTRAINT submission_usage_workspace
 FOREIGN KEY(assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.submissions_submission ADD CONSTRAINT submission_author_name_bytes CHECK(octet_length(author_display_name)<=320);
ALTER TABLE public.submissions_submissionparticipant ADD CONSTRAINT submission_participant_name_bytes CHECK(octet_length(display_name)<=320);
CREATE FUNCTION public.submission_reject_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Submission records are immutable.' USING ERRCODE='check_violation'; END;
$$;
CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON public.submissions_submission
 FOR EACH ROW EXECUTE FUNCTION public.submission_reject_change();
CREATE FUNCTION public.submission_guard_participant() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent public.submissions_submission%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Submission participants are immutable.' USING ERRCODE='check_violation'; END IF;
 SELECT * INTO parent FROM public.submissions_submission WHERE id=NEW.submission_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Submission participant requires its parent.' USING ERRCODE='foreign_key_violation'; END IF;
 IF (SELECT count(*) FROM public.submissions_submissionparticipant WHERE submission_id=NEW.submission_id)>=parent.participant_count THEN
 RAISE EXCEPTION 'Submission participant set is complete.' USING ERRCODE='check_violation', CONSTRAINT='submission_participants_sealed'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_submission_participant BEFORE INSERT OR UPDATE OR DELETE ON public.submissions_submissionparticipant
 FOR EACH ROW EXECUTE FUNCTION public.submission_guard_participant();
CREATE FUNCTION public.submission_verify_participant_set() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE parent_id uuid; expected smallint; actual bigint;
BEGIN
 IF TG_TABLE_NAME='submissions_submission' THEN parent_id=NEW.id; ELSE parent_id=NEW.submission_id; END IF;
 SELECT participant_count INTO expected FROM public.submissions_submission WHERE id=parent_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Submission participant set requires its parent.' USING ERRCODE='foreign_key_violation'; END IF;
 SELECT count(*) INTO actual FROM public.submissions_submissionparticipant WHERE submission_id=parent_id;
 IF actual<>expected THEN
 RAISE EXCEPTION 'Submission participant set must be complete at commit.' USING ERRCODE='check_violation', CONSTRAINT='submission_participant_set_complete'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER submission_complete_parent AFTER INSERT ON public.submissions_submission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.submission_verify_participant_set();
CREATE CONSTRAINT TRIGGER submission_complete_member AFTER INSERT ON public.submissions_submissionparticipant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.submission_verify_participant_set();
"""
REVERSE = """
DROP TRIGGER submission_complete_member ON public.submissions_submissionparticipant;
DROP TRIGGER submission_complete_parent ON public.submissions_submission;
DROP FUNCTION public.submission_verify_participant_set();
DROP TRIGGER immutable_submission_participant ON public.submissions_submissionparticipant;
DROP FUNCTION public.submission_guard_participant();
DROP TRIGGER immutable_submission ON public.submissions_submission;
DROP FUNCTION public.submission_reject_change();
ALTER TABLE public.submissions_submissionparticipant DROP CONSTRAINT submission_participant_name_bytes;
ALTER TABLE public.submissions_submission DROP CONSTRAINT submission_author_name_bytes;
ALTER TABLE public.submissions_submissionassignmentusage DROP CONSTRAINT submission_usage_workspace;
ALTER TABLE public.submissions_submissionparticipant DROP CONSTRAINT submission_participation_identity;
ALTER TABLE public.submissions_submissionparticipant DROP CONSTRAINT submission_participant_parent;
ALTER TABLE public.submissions_submission DROP CONSTRAINT submission_team_binding;
ALTER TABLE public.submissions_submission DROP CONSTRAINT submission_revision_binding;
ALTER TABLE public.submissions_submission DROP CONSTRAINT submission_work_binding;
"""


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
            "Retained private submissions require their authorization and integrity schema."
        )


class Migration(migrations.Migration):
    dependencies = [("submissions", "0001_initial")]
    operations = [
        migrations.RunSQL(FORWARD, REVERSE),
        migrations.RunPython(migrations.RunPython.noop, refuse_private_reversal),
    ]

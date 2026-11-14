from django.db import migrations

FORWARD = """
ALTER TABLE public.learning_assignmentteam ADD CONSTRAINT team_assignment_workspace
 FOREIGN KEY (assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentparticipation ADD CONSTRAINT participation_assignment_workspace
 FOREIGN KEY (assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentparticipation ADD CONSTRAINT participation_workspace_member
 FOREIGN KEY (workspace_id,user_id) REFERENCES public.workspaces_workspacemembership(workspace_id,user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentparticipation ADD CONSTRAINT participation_team_assignment
 FOREIGN KEY (team_id,assignment_id) REFERENCES public.learning_assignmentteam(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentwork ADD CONSTRAINT work_assignment_workspace
 FOREIGN KEY (assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentwork ADD CONSTRAINT work_version_assignment
 FOREIGN KEY (assignment_version_id,assignment_id) REFERENCES public.learning_assignmentversion(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentwork ADD CONSTRAINT work_participation_assignment
 FOREIGN KEY (participation_id,assignment_id) REFERENCES public.learning_assignmentparticipation(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentwork ADD CONSTRAINT work_team_assignment
 FOREIGN KEY (team_id,assignment_id) REFERENCES public.learning_assignmentteam(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentwork ADD CONSTRAINT work_project_workspace
 FOREIGN KEY (project_id,workspace_id) REFERENCES public.projects_project(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentworkmember ADD CONSTRAINT work_member_assignment
 FOREIGN KEY (work_id,assignment_id) REFERENCES public.learning_assignmentwork(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentworkmember ADD CONSTRAINT work_member_participation_identity
 FOREIGN KEY (participation_id,assignment_id,user_id) REFERENCES public.learning_assignmentparticipation(id,assignment_id,user_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentteam ADD CONSTRAINT team_name_bytes CHECK(octet_length(name)<=320);
ALTER TABLE public.learning_assignmentworkmember ADD CONSTRAINT work_member_name_bytes CHECK(octet_length(display_name)<=320);

CREATE FUNCTION public.learning_guard_work_change() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Assignment work cannot be deleted.' USING ERRCODE='check_violation';
 END IF;
 IF ROW(NEW.id,NEW.assignment_id,NEW.workspace_id,NEW.assignment_version_id,
        NEW.created_by_id,NEW.subject_kind,NEW.participation_id,NEW.team_id,
        NEW.team_roster_revision,NEW.project_id,NEW.client_request_id,
        NEW.request_sha256,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.assignment_id,OLD.workspace_id,OLD.assignment_version_id,
        OLD.created_by_id,OLD.subject_kind,OLD.participation_id,OLD.team_id,
        OLD.team_roster_revision,OLD.project_id,OLD.client_request_id,
        OLD.request_sha256,OLD.created_at) THEN
  RAISE EXCEPTION 'Assignment work identity cannot change.' USING ERRCODE='check_violation';
 END IF;
 IF ROW(NEW.state,NEW.retired_at,NEW.retired_reason)
    IS NOT DISTINCT FROM ROW(OLD.state,OLD.retired_at,OLD.retired_reason) THEN
  RETURN NEW;
 END IF;
 IF OLD.state<>'active' OR NEW.state<>'retired' THEN
  RAISE EXCEPTION 'Assignment work can only be retired once.' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_assignment_work BEFORE UPDATE OR DELETE
 ON public.learning_assignmentwork FOR EACH ROW EXECUTE FUNCTION public.learning_guard_work_change();

CREATE FUNCTION public.learning_guard_work_member() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE bound_work public.learning_assignmentwork%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Assignment work membership is immutable.' USING ERRCODE='check_violation';
 END IF;
 SELECT * INTO bound_work FROM public.learning_assignmentwork WHERE id=NEW.work_id FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Assignment work membership requires its work.' USING ERRCODE='foreign_key_violation';
 END IF;
 IF (SELECT count(*) FROM public.learning_assignmentworkmember WHERE work_id=NEW.work_id)>=6 THEN
  RAISE EXCEPTION 'Assignment work membership capacity reached.' USING ERRCODE='check_violation';
 END IF;
 IF (NEW.user_id=bound_work.created_by_id AND NEW.source_role_at_creation<>'owner')
    OR (NEW.user_id<>bound_work.created_by_id AND NEW.source_role_at_creation<>'editor')
    OR (bound_work.subject_kind='individual' AND
        (NEW.participation_id<>bound_work.participation_id OR NEW.consent_roster_revision IS NOT NULL))
    OR (bound_work.subject_kind='team' AND
        NEW.consent_roster_revision IS DISTINCT FROM bound_work.team_roster_revision) THEN
  RAISE EXCEPTION 'Assignment work access intent does not match its subject.' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_assignment_work_member BEFORE INSERT OR UPDATE OR DELETE
 ON public.learning_assignmentworkmember FOR EACH ROW EXECUTE FUNCTION public.learning_guard_work_member();
"""

REVERSE = """
DROP TRIGGER immutable_assignment_work_member ON public.learning_assignmentworkmember;
DROP FUNCTION public.learning_guard_work_member();
DROP TRIGGER guarded_assignment_work ON public.learning_assignmentwork;
DROP FUNCTION public.learning_guard_work_change();
ALTER TABLE public.learning_assignmentworkmember DROP CONSTRAINT work_member_name_bytes;
ALTER TABLE public.learning_assignmentteam DROP CONSTRAINT team_name_bytes;
ALTER TABLE public.learning_assignmentworkmember DROP CONSTRAINT work_member_participation_identity;
ALTER TABLE public.learning_assignmentworkmember DROP CONSTRAINT work_member_assignment;
ALTER TABLE public.learning_assignmentwork DROP CONSTRAINT work_project_workspace;
ALTER TABLE public.learning_assignmentwork DROP CONSTRAINT work_team_assignment;
ALTER TABLE public.learning_assignmentwork DROP CONSTRAINT work_participation_assignment;
ALTER TABLE public.learning_assignmentwork DROP CONSTRAINT work_version_assignment;
ALTER TABLE public.learning_assignmentwork DROP CONSTRAINT work_assignment_workspace;
ALTER TABLE public.learning_assignmentparticipation DROP CONSTRAINT participation_team_assignment;
ALTER TABLE public.learning_assignmentparticipation DROP CONSTRAINT participation_workspace_member;
ALTER TABLE public.learning_assignmentparticipation DROP CONSTRAINT participation_assignment_workspace;
ALTER TABLE public.learning_assignmentteam DROP CONSTRAINT team_assignment_workspace;
"""


class Migration(migrations.Migration):
    dependencies = [("learning", "0003_participation_teams_work")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

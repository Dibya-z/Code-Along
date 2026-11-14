from django.db import migrations

FORWARD = """
ALTER TABLE public.learning_assignmentversion ADD CONSTRAINT assignment_version_assignment_workspace
 FOREIGN KEY (assignment_id,workspace_id) REFERENCES public.learning_assignment(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentversion ADD CONSTRAINT assignment_version_project_workspace
 FOREIGN KEY (starter_project_id,workspace_id) REFERENCES public.projects_project(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignmentversion ADD CONSTRAINT assignment_version_revision_project
 FOREIGN KEY (starter_revision_id,starter_project_id) REFERENCES public.projects_projectrevision(id,project_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignment ADD CONSTRAINT assignment_draft_project_workspace
 FOREIGN KEY (draft_starter_project_id,workspace_id) REFERENCES public.projects_project(id,workspace_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignment ADD CONSTRAINT assignment_draft_revision_project
 FOREIGN KEY (draft_starter_revision_id,draft_starter_project_id) REFERENCES public.projects_projectrevision(id,project_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignment ADD CONSTRAINT assignment_current_version_parent
 FOREIGN KEY (current_version_id,id) REFERENCES public.learning_assignmentversion(id,assignment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.learning_assignment ADD CONSTRAINT assignment_draft_text_bytes CHECK (
 octet_length(draft_title)<=480 AND octet_length(draft_instructions)<=32768 AND
 (draft_public_checks_source IS NULL OR octet_length(draft_public_checks_source)<=16384) AND
 jsonb_typeof(draft_hints)='array' AND jsonb_array_length(draft_hints)<=8);
ALTER TABLE public.learning_assignmentversion ADD CONSTRAINT assignment_version_text_bytes CHECK (
 octet_length(title)<=480 AND octet_length(instructions)<=32768 AND
 jsonb_typeof(hints)='array' AND jsonb_array_length(hints)<=8);
CREATE FUNCTION public.learning_reject_version_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable assignment version cannot change.' USING ERRCODE='check_violation'; END;
$$;
CREATE TRIGGER immutable_assignment_version BEFORE UPDATE OR DELETE ON public.learning_assignmentversion
 FOR EACH ROW EXECUTE FUNCTION public.learning_reject_version_change();
"""

REVERSE = """
DROP TRIGGER immutable_assignment_version ON public.learning_assignmentversion;
DROP FUNCTION public.learning_reject_version_change();
ALTER TABLE public.learning_assignmentversion DROP CONSTRAINT assignment_version_text_bytes;
ALTER TABLE public.learning_assignment DROP CONSTRAINT assignment_draft_text_bytes;
ALTER TABLE public.learning_assignment DROP CONSTRAINT assignment_current_version_parent;
ALTER TABLE public.learning_assignment DROP CONSTRAINT assignment_draft_revision_project;
ALTER TABLE public.learning_assignment DROP CONSTRAINT assignment_draft_project_workspace;
ALTER TABLE public.learning_assignmentversion DROP CONSTRAINT assignment_version_revision_project;
ALTER TABLE public.learning_assignmentversion DROP CONSTRAINT assignment_version_project_workspace;
ALTER TABLE public.learning_assignmentversion DROP CONSTRAINT assignment_version_assignment_workspace;
"""


class Migration(migrations.Migration):
    dependencies = [("learning", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]

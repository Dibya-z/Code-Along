from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("projects", "0007_sharegrant_share_project_pair")]
    operations = [
        migrations.RunSQL(
            "ALTER TABLE projects_projectrevision ADD CONSTRAINT revision_entrypoint_member FOREIGN KEY(id,entrypoint_file_id) REFERENCES projects_revisionfile(revision_id,file_id) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE projects_revisionfile ADD CONSTRAINT revision_source_byte_count CHECK(octet_length(source)=source_bytes);"
            "ALTER TABLE projects_sharegrant ADD CONSTRAINT share_revision_parent FOREIGN KEY(revision_id,project_id) REFERENCES projects_projectrevision(id,project_id) DEFERRABLE INITIALLY DEFERRED;"
            "CREATE FUNCTION projects_reject_revision_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Immutable revision cannot change.' USING ERRCODE='check_violation'; END; $$;"
            "CREATE TRIGGER immutable_project_revision BEFORE UPDATE OR DELETE ON projects_projectrevision FOR EACH ROW EXECUTE FUNCTION projects_reject_revision_change();"
            "CREATE TRIGGER immutable_revision_file BEFORE UPDATE OR DELETE ON projects_revisionfile FOR EACH ROW EXECUTE FUNCTION projects_reject_revision_change();",
            "DROP TRIGGER immutable_revision_file ON projects_revisionfile;"
            "DROP TRIGGER immutable_project_revision ON projects_projectrevision;"
            "DROP FUNCTION projects_reject_revision_change();"
            "ALTER TABLE projects_sharegrant DROP CONSTRAINT share_revision_parent;"
            "ALTER TABLE projects_revisionfile DROP CONSTRAINT revision_source_byte_count;"
            "ALTER TABLE projects_projectrevision DROP CONSTRAINT revision_entrypoint_member;",
        )
    ]

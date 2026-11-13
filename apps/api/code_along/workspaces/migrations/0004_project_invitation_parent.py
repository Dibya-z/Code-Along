from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("workspaces", "0003_remove_workspaceinvitation_invitation_valid_role_and_more")
    ]
    operations = [
        migrations.RunSQL(
            "ALTER TABLE workspaces_workspaceinvitation ADD CONSTRAINT invitation_project_workspace FOREIGN KEY (project_id, workspace_id) REFERENCES projects_project(id, workspace_id) DEFERRABLE INITIALLY DEFERRED;",
            "ALTER TABLE workspaces_workspaceinvitation DROP CONSTRAINT invitation_project_workspace;",
        )
    ]

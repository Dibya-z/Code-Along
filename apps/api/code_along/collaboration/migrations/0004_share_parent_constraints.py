from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("collaboration", "0003_collaborationlease_share_grant_and_more"),
        ("projects", "0008_revision_integrity"),
    ]
    operations = [
        migrations.RunSQL(
            "ALTER TABLE collaboration_collaborationticket ADD CONSTRAINT ticket_share_parent FOREIGN KEY(share_grant_id,project_id) REFERENCES projects_sharegrant(id,project_id) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE collaboration_collaborationlease ADD CONSTRAINT lease_share_parent FOREIGN KEY(share_grant_id,project_id) REFERENCES projects_sharegrant(id,project_id) DEFERRABLE INITIALLY DEFERRED;",
            "ALTER TABLE collaboration_collaborationlease DROP CONSTRAINT lease_share_parent;"
            "ALTER TABLE collaboration_collaborationticket DROP CONSTRAINT ticket_share_parent;",
        )
    ]

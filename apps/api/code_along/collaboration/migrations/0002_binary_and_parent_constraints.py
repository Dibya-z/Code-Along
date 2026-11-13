from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("collaboration", "0001_initial"),
        ("projects", "0005_collaborationdocument_document_project_generation"),
    ]
    operations = [
        migrations.RunSQL(
            "ALTER TABLE collaboration_documentstate ADD CONSTRAINT state_binary_bounds CHECK (octet_length(binary_state) BETWEEN 1 AND 1048576);"
            "ALTER TABLE collaboration_documentstate ADD CONSTRAINT state_document_generation FOREIGN KEY (document_id,generation) REFERENCES projects_collaborationdocument(id,generation) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE collaboration_checkpointreceipt ADD CONSTRAINT receipt_document_generation FOREIGN KEY (document_id,generation) REFERENCES projects_collaborationdocument(id,generation) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE collaboration_collaborationticket ADD CONSTRAINT ticket_document_parent FOREIGN KEY (document_id,project_id,generation) REFERENCES projects_collaborationdocument(id,project_id,generation) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE collaboration_collaborationlease ADD CONSTRAINT lease_document_parent FOREIGN KEY (document_id,project_id,generation) REFERENCES projects_collaborationdocument(id,project_id,generation) DEFERRABLE INITIALLY DEFERRED;",
            "ALTER TABLE collaboration_collaborationlease DROP CONSTRAINT lease_document_parent;"
            "ALTER TABLE collaboration_collaborationticket DROP CONSTRAINT ticket_document_parent;"
            "ALTER TABLE collaboration_checkpointreceipt DROP CONSTRAINT receipt_document_generation;"
            "ALTER TABLE collaboration_documentstate DROP CONSTRAINT state_document_generation;"
            "ALTER TABLE collaboration_documentstate DROP CONSTRAINT state_binary_bounds;",
        )
    ]

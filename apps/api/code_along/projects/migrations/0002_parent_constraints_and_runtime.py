import uuid

from django.db import migrations

# Frozen, independently authored M0 asset inventory. Never load mutable files in a migration.
PROFILE = {
    "assets": [
        {
            "bytes": 17931,
            "name": "pyodide.mjs",
            "sha256": "6f1d60f7bf529beb300f0f47983c921d3982363640ba20af0e38efdddbc66109",
        },
        {
            "bytes": 1250344,
            "name": "pyodide.asm.mjs",
            "sha256": "f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635",
        },
        {
            "bytes": 9598218,
            "name": "pyodide.asm.wasm",
            "sha256": "cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6",
        },
        {
            "bytes": 2545637,
            "name": "python_stdlib.zip",
            "sha256": "fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a",
        },
        {
            "bytes": 119077,
            "name": "pyodide-lock.json",
            "sha256": "5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010",
        },
    ],
    "package": "pyodide",
    "runtime_id": "pyodide-314.0.7-core",
    "version": 1,
    "version_pin": "314.0.7",
}
PROFILE_ID = uuid.UUID("017ab264-9c81-5879-b594-801c62dba89f")


def seed(apps, schema_editor):
    apps.get_model("projects", "RuntimeProfile").objects.create(
        id=PROFILE_ID,
        runtime_id=PROFILE["runtime_id"],
        manifest=PROFILE,
        manifest_sha256="4eb12f345e0f14f57c93603c8d8a2d3d62c69e2e82618c63cac87dc0aafadf40",
    )


def unseed(apps, schema_editor):
    apps.get_model("projects", "RuntimeProfile").objects.filter(id=PROFILE_ID).delete()


class Migration(migrations.Migration):
    dependencies = [("projects", "0001_initial")]
    operations = [
        migrations.RunSQL(
            "ALTER TABLE projects_project ADD CONSTRAINT project_entrypoint_parent FOREIGN KEY (entrypoint_file_id, id) REFERENCES projects_projectfile(id, project_id) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE projects_project ADD CONSTRAINT project_owner_member FOREIGN KEY (workspace_id, owner_id) REFERENCES workspaces_workspacemembership(workspace_id, user_id) DEFERRABLE INITIALLY DEFERRED;"
            "ALTER TABLE projects_collaborationdocument ADD CONSTRAINT document_file_parent_generation FOREIGN KEY (file_id, project_id, generation) REFERENCES projects_projectfile(id, project_id, generation) DEFERRABLE INITIALLY DEFERRED;",
            "ALTER TABLE projects_collaborationdocument DROP CONSTRAINT document_file_parent_generation;"
            "ALTER TABLE projects_project DROP CONSTRAINT project_owner_member;"
            "ALTER TABLE projects_project DROP CONSTRAINT project_entrypoint_parent;",
        ),
        migrations.RunPython(seed, unseed),
    ]

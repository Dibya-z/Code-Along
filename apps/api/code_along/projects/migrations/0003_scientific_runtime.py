import uuid

from django.db import migrations

# Frozen reviewed asset inventory; migration history never loads mutable manifests.
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
        {
            "bytes": 2960568,
            "name": "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
            "sha256": "a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf",
        },
    ],
    "package": "pyodide",
    "packages": ["numpy"],
    "python_version": "3.14.2",
    "runtime_id": "pyodide-314.0.7-scientific",
    "version": 1,
    "version_pin": "314.0.7",
}
PROFILE_ID = uuid.UUID("cd31451c-2069-5eab-9b93-2fcbe8ed19bc")


def seed(apps, schema_editor):
    apps.get_model("projects", "RuntimeProfile").objects.create(
        id=PROFILE_ID,
        runtime_id=PROFILE["runtime_id"],
        manifest=PROFILE,
        manifest_sha256="eb2bfd5f172ccce38411575452b4c723f939a14e095a94a612fb1f9d5fdf21ea",
    )


def unseed(apps, schema_editor):
    apps.get_model("projects", "RuntimeProfile").objects.filter(id=PROFILE_ID).delete()


class Migration(migrations.Migration):
    dependencies = [("projects", "0002_parent_constraints_and_runtime")]
    operations = [migrations.RunPython(seed, unseed)]

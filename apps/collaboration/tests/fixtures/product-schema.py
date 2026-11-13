"""Real Django migrations/provisioning in the private PG18 harness, never proof DDL."""

import io
import json
import os
import re
import stat
import sys
from pathlib import Path


def main() -> None:
    host = os.environ.get("PGHOST", "")
    if (
        not re.fullmatch(r"/tmp/ca-pg18-[^/]+/socket", host)
        or os.environ.get("PGUSER") != "code_along_test"
        or os.environ.get("PGDATABASE") != "postgres"
        or stat.S_IMODE(Path(host).stat().st_mode) != 0o700
    ):
        raise RuntimeError("owned_cluster_required")
    api = Path(__file__).resolve().parents[3] / "api"
    sys.path.insert(0, str(api))
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.test"
    from django.conf import settings

    settings.DATABASES["default"].update(
        NAME="postgres",
        USER="code_along_test",
        PASSWORD="",
        HOST=host,
        PORT=5432,
        CONN_MAX_AGE=0,
        OPTIONS={"connect_timeout": 2, "sslmode": "disable"},
    )
    import django

    django.setup()
    from allauth.account.models import EmailAddress
    from code_along.accounts.models import User
    from code_along.projects import services as projects
    from code_along.workspaces import services as workspaces
    from django.core.management import call_command
    from django.db import connections

    call_command("migrate", interactive=False, verbosity=0, stdout=io.StringIO())
    call_command("provision_collaboration_role", stdout=io.StringIO())
    owner = User.objects.create_user(
        email="node-product-fixture@example.test", display_name="River"
    )
    EmailAddress.objects.create(
        user=owner, email=owner.email, verified=True, primary=True
    )
    workspace = workspaces.create_workspace(owner, "Owned Node fixture")
    documents = []
    for index in range(3):
        project = projects.create_project(owner, workspace.id, f"Fixture {index}")
        file = project.files.get()
        document = project.documents.get()
        documents.append(
            {
                "project_id": str(project.id),
                "file_id": str(file.id),
                "document_id": str(document.id),
                "generation": document.generation,
            }
        )
    connections.close_all()
    print(json.dumps({"documents": documents}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not expose driver/role/source details through fixture failures.
        print("product_fixture_failed", file=sys.stderr)
        raise SystemExit(1) from None

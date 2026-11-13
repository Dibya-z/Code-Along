import hashlib
import secrets
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from psycopg import sql

from code_along.collaboration.management.commands.provision_collaboration_role import (
    provision_role,
)
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.projects import services as projects
from code_along.workspaces import services as workspaces
from code_along.workspaces.tests.test_workspaces import person

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def runtime_catalog() -> None:
    ensure_runtime_catalog()


@contextmanager
def restricted_role() -> Iterator[tuple[str, str]]:
    role = f"ca_collab_{uuid.uuid4().hex[:12]}"
    password = secrets.token_urlsafe(32)
    provision_role(role, password)
    try:
        yield role, password
    finally:
        # Only the fresh role owned by this private PG18 test is touched.
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)).as_string()
            )
            cursor.execute(
                sql.SQL("DROP ROLE {}").format(sql.Identifier(role)).as_string()
            )


def test_product_schema_and_real_restricted_role_preserve_binary_receipt_boundary() -> (
    None
):
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = projects.create_project(owner, workspace.id, "Project")
    document = project.documents.get()
    binary = b"\x00\x00"
    digest = hashlib.sha256(binary).hexdigest()
    with restricted_role() as (role, password):
        provision_role(role, password)  # Owned-role rerun is safe/idempotent.
        database = connection.settings_dict
        with psycopg.connect(
            dbname=database["NAME"],
            host=database["HOST"],
            port=database["PORT"],
            user=role,
            password=password,
            connect_timeout=2,
            autocommit=True,
        ) as writer:
            assert writer.execute(
                "SELECT id,generation FROM projects_collaborationdocument WHERE id=%s",
                [document.id],
            ).fetchone() == (document.id, 1)
            writer.execute(
                "INSERT INTO collaboration_documentstate (document_id,generation,binary_state,durable_revision,state_sha256) VALUES (%s,1,%s,0,%s)",
                [document.id, binary, digest],
            )
            writer.execute(
                "UPDATE collaboration_documentstate SET durable_revision=1,updated_at=now() WHERE document_id=%s",
                [document.id],
            )
            receipt = writer.execute(
                "INSERT INTO collaboration_checkpointreceipt (document_id,generation,client_session_id,checkpoint_id,observed_counter,request_sha256,durable_revision,state_sha256) VALUES (%s,1,%s,%s,0,%s,1,%s) RETURNING id,recorded_at",
                [document.id, uuid.uuid4(), uuid.uuid4(), digest, digest],
            ).fetchone()
            assert (
                receipt
                and isinstance(receipt[0], uuid.UUID)
                and receipt[1].tzinfo is not None
            )
            stored = writer.execute(
                "SELECT binary_state,initialized_at FROM collaboration_documentstate WHERE document_id=%s",
                [document.id],
            ).fetchone()
            assert stored and stored[0] == binary and stored[1].tzinfo is not None
            for statement in (
                "SELECT initial_source FROM projects_projectfile",
                "SELECT * FROM django_session",
                "SELECT * FROM accounts_user",
                "UPDATE projects_collaborationdocument SET schema_version=1",
                "UPDATE collaboration_documentstate SET generation=1",
                "DELETE FROM collaboration_documentstate",
                "DELETE FROM collaboration_checkpointreceipt",
                "CREATE TABLE public.collaboration_forbidden (id integer)",
            ):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    writer.execute(statement)


@pytest.mark.parametrize("drift", ["session", "source", "ownership"])
def test_existing_role_with_extra_privileges_or_ownership_is_rejected(
    drift: str,
) -> None:
    with restricted_role() as (role, password):
        with connection.cursor() as cursor:
            if drift == "session":
                statement = sql.SQL("GRANT SELECT ON django_session TO {}").format(
                    sql.Identifier(role)
                )
            elif drift == "source":
                statement = sql.SQL(
                    "GRANT SELECT(initial_source) ON projects_projectfile TO {}"
                ).format(sql.Identifier(role))
            else:
                statement = sql.SQL("CREATE SCHEMA {} AUTHORIZATION {}").format(
                    sql.Identifier(role), sql.Identifier(role)
                )
            cursor.execute(statement.as_string())
        with pytest.raises(CommandError, match="unexpected|object-owning"):
            provision_role(role, password)


def test_unmarked_existing_role_is_not_repurposed() -> None:
    role = f"ca_collab_{uuid.uuid4().hex[:12]}"
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("CREATE ROLE {}").format(sql.Identifier(role)).as_string()
        )
    try:
        with pytest.raises(CommandError, match="unowned"):
            provision_role(role, secrets.token_urlsafe(32))
    finally:
        with connection.cursor() as cursor:
            cursor.execute(
                sql.SQL("DROP ROLE {}").format(sql.Identifier(role)).as_string()
            )


def test_binary_size_and_generation_constraints_and_migration_state() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = projects.create_project(owner, workspace.id, "Project")
    document = project.documents.get()
    with (
        pytest.raises(psycopg.errors.CheckViolation),
        psycopg.connect(
            **{
                "dbname": connection.settings_dict["NAME"],
                "host": connection.settings_dict["HOST"],
                "port": connection.settings_dict["PORT"],
                "user": connection.settings_dict["USER"],
            },
            autocommit=True,
        ) as owner_connection,
    ):
        owner_connection.execute(
            "INSERT INTO collaboration_documentstate (document_id,generation,binary_state,state_sha256) VALUES (%s,1,%s,%s)",
            [document.id, b"x" * (1048576 + 1), "0" * 64],
        )
    with (
        psycopg.connect(
            dbname=connection.settings_dict["NAME"],
            host=connection.settings_dict["HOST"],
            port=connection.settings_dict["PORT"],
            user=connection.settings_dict["USER"],
        ) as owner_connection,
        pytest.raises(psycopg.errors.ForeignKeyViolation),
    ):
        owner_connection.execute(
            "INSERT INTO collaboration_documentstate (document_id,generation,binary_state,state_sha256) VALUES (%s,2,%s,%s)",
            [document.id, b"\x00\x00", "0" * 64],
        )
        owner_connection.commit()
    call_command(
        "makemigrations",
        "collaboration",
        "projects",
        check=True,
        dry_run=True,
        verbosity=0,
    )

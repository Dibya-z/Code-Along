"""Provision only the configured dedicated writer, after product migrations."""

import os
import re
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, connection, transaction
from psycopg import sql

METADATA_COLUMNS = {
    "projects_collaborationdocument": "id, project_id, file_id, generation, kind, schema_version",
    "projects_projectfile": "id, project_id, generation, deleted_at, initial_sha256",
}
STATE = "collaboration_documentstate"
RECEIPT = "collaboration_checkpointreceipt"
OWNER_MARKER = "code-along:collaboration-writer:v1"


def verify_existing_role(user: str) -> None:
    """Never repurpose an unrelated role or silently retain privilege drift."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT shobj_description(oid,'pg_authid'), "
            "EXISTS(SELECT 1 FROM pg_shdepend d WHERE d.refobjid=r.oid AND d.deptype='o') "
            "FROM pg_roles r WHERE rolname=%s",
            [user],
        )
        row = cursor.fetchone()
        if row != (OWNER_MARKER, False):
            raise CommandError(
                "Refusing an unowned or object-owning collaboration role."
            )
        cursor.execute(
            "SELECT c.relname,a.attname, "
            "has_column_privilege(%s,c.oid,a.attnum,'SELECT'), "
            "has_column_privilege(%s,c.oid,a.attnum,'INSERT'), "
            "has_column_privilege(%s,c.oid,a.attnum,'UPDATE'), "
            "has_column_privilege(%s,c.oid,a.attnum,'REFERENCES') "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "JOIN pg_attribute a ON a.attrelid=c.oid "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') "
            "AND a.attnum>0 AND NOT a.attisdropped",
            [user] * 4,
        )
        updates = {"binary_state", "durable_revision", "state_sha256", "updated_at"}
        for table, column, select, insert, update, references in cursor.fetchall():
            allowed_select = table in {STATE, RECEIPT} or column in {
                name.strip() for name in METADATA_COLUMNS.get(table, "").split(",")
            }
            if (
                select
                and not allowed_select
                or insert
                and table not in {STATE, RECEIPT}
                or update
                and not (table == STATE and column in updates)
                or references
            ):
                raise CommandError(
                    "The dedicated collaboration role has unexpected privileges."
                )
        cursor.execute(
            "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') "
            "AND has_table_privilege(%s,c.oid,'DELETE,TRUNCATE,TRIGGER'))",
            [user],
        )
        if cursor.fetchone() != (False,):
            raise CommandError(
                "The dedicated collaboration role has unexpected table privileges."
            )


def provision_role(user: str, password: str) -> None:
    if (
        not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", user)
        or user in {"postgres", "public"}
        or user.startswith("pg_")
        or len(password) < 32
        or "\0" in password
    ):
        raise CommandError(
            "Configure a dedicated role and a secret of at least 32 characters."
        )
    role = sql.Identifier(user)
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT current_user")
            if cursor.fetchone() == (user,):
                raise CommandError(
                    "The collaboration role cannot be the database owner."
                )
            cursor.execute(
                "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, "
                "EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) "
                "FROM pg_roles r WHERE rolname=%s",
                [user],
            )
            existing = cursor.fetchone()
            if existing and any(existing):
                raise CommandError(
                    "Refusing to repurpose a privileged or shared database role."
                )
            if existing:
                verify_existing_role(user)
            operation = "ALTER" if existing else "CREATE"
            statement = sql.SQL(
                operation
                + " ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE "
                "NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD {}"
            ).format(role, sql.Literal(password))
            cursor.execute(statement.as_string())
            if not existing:
                cursor.execute(
                    sql.SQL("COMMENT ON ROLE {} IS {}")
                    .format(role, sql.Literal(OWNER_MARKER))
                    .as_string()
                )
            cursor.execute("SELECT current_database()")
            database = cursor.fetchone()
            assert database is not None
            cursor.execute(
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}")
                .format(sql.Identifier(database[0]), role)
                .as_string()
            )
            cursor.execute(
                sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(role).as_string()
            )
            cursor.execute(
                "SELECT has_schema_privilege(%s, 'public', 'CREATE')", [user]
            )
            if cursor.fetchone() != (False,):
                raise CommandError(
                    "The dedicated role inherits public schema CREATE privileges."
                )
            for table, columns in METADATA_COLUMNS.items():
                cursor.execute(
                    sql.SQL("REVOKE ALL ON TABLE {} FROM {}")
                    .format(sql.Identifier(table), role)
                    .as_string()
                )
                cursor.execute(
                    sql.SQL("GRANT SELECT (" + columns + ") ON TABLE {} TO {}")
                    .format(sql.Identifier(table), role)
                    .as_string()
                )
            for table in (STATE, RECEIPT):
                cursor.execute(
                    sql.SQL("REVOKE ALL ON TABLE {} FROM {}")
                    .format(sql.Identifier(table), role)
                    .as_string()
                )
                cursor.execute(
                    sql.SQL("GRANT SELECT, INSERT ON TABLE {} TO {}")
                    .format(sql.Identifier(table), role)
                    .as_string()
                )
            cursor.execute(
                sql.SQL(
                    "GRANT UPDATE (binary_state,durable_revision,state_sha256,updated_at) ON TABLE {} TO {}"
                )
                .format(sql.Identifier(STATE), role)
                .as_string()
            )
    except DatabaseError:
        # SQL errors may contain role/password/source; never chain their cause.
        raise CommandError("Collaboration role provisioning failed.") from None


class Command(BaseCommand):
    help = "Provision the configured restricted collaboration role without displaying secrets."

    def handle(self, *args: Any, **options: Any) -> None:
        provision_role(
            os.environ.get("CODE_ALONG_COLLABORATION_DB_USER", ""),
            os.environ.get("CODE_ALONG_COLLABORATION_DB_PASSWORD", ""),
        )
        self.stdout.write("Restricted collaboration role is ready.")

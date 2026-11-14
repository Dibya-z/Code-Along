"""Restore actual application data only inside pytest's owned PG18 cluster."""

import base64
import hashlib
import json
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest
from code_along.collaboration.models import CheckpointReceipt, DocumentState
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.submissions.models import FeedbackPublication
from code_along.submissions.tests.test_feedback import feedback_fixture, publish, save
from django.core.cache import cache
from django.db import connection
from psycopg import sql

from tools.dev.postgres_cluster import find_postgres_binaries
from tools.ops.postgres_backup import ARCHIVE, create_backup, verify_backup


def _yjs(mode: str, payload: str) -> str:
    root = Path(__file__).resolve().parents[4]
    script = """
      import { readFileSync } from 'node:fs';
      import * as Y from 'yjs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const doc = new Y.Doc();
      if (process.argv[1] === 'encode') {
        doc.getText('source').insert(0, input);
        process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'));
      } else {
        Y.applyUpdate(doc, Buffer.from(input, 'base64'));
        process.stdout.write(JSON.stringify(doc.getText('source').toString()));
      }
      doc.destroy();
    """
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, mode],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=root / "apps/collaboration",
        timeout=10,
        check=False,
        env={"PATH": os.environ.get("PATH", "")},
    )
    assert result.returncode == 0, "Owned canonical-source fixture failed"
    return result.stdout


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_dump_restores_real_project_canonical_source_submission_and_published_feedback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in list(os.environ):
        if name.startswith("PG"):
            monkeypatch.delenv(name)
    database = connection.settings_dict
    socket = Path(database["HOST"])
    assert (
        database["NAME"] == "test_code_along_api"
        and database["USER"] == "code_along_test"
        and socket.name == "socket"
        and socket.parent.name.startswith("ca-pg18-")
        and connection.get_autocommit()
    ), "Restore exercise requires the owned disposable PostgreSQL harness"
    ensure_runtime_catalog()
    cache.clear()
    teacher, _, submission = feedback_fixture()
    comments = "Restored manual feedback 🐍\r\nKeep exact text."
    assert save(teacher, submission, comments=comments).status_code == 200
    published = publish(teacher, submission)
    assert published.status_code == 201
    publication = FeedbackPublication.objects.get(id=published.json()["id"])
    project = submission.project
    file = project.files.get()
    source = "\ufeffprint('restored live source 🐍')\r\n"
    binary = base64.b64decode(_yjs("encode", source))
    state = DocumentState.objects.create(
        document=file.document,
        generation=file.generation,
        binary_state=binary,
        durable_revision=7,
        state_sha256=hashlib.sha256(binary).hexdigest(),
    )
    receipt = CheckpointReceipt.objects.create(
        document=file.document,
        generation=file.generation,
        client_session_id=uuid.uuid4(),
        checkpoint_id=uuid.uuid4(),
        observed_counter=3,
        request_sha256="a" * 64,
        durable_revision=7,
        state_sha256=state.state_sha256,
    )
    frozen = submission.revision.files.get()
    participant = submission.participants.get()
    with connection.cursor() as cursor:
        cursor.execute("SELECT count(*) FROM django_migrations")
        migration_count = cursor.fetchone()[0]
    binaries = find_postgres_binaries()
    env = {
        **os.environ,
        "PGHOST": str(socket),
        "PGPORT": str(database["PORT"]),
        "PGDATABASE": database["NAME"],
        "PGUSER": database["USER"],
        "PGPASSWORD": database["PASSWORD"],
        "PGSSLMODE": "disable",
    }
    output = tmp_path / "application-backup"
    manifest = create_backup(output, pg_bin=binaries.directory, environ=env, timeout=60)
    assert (
        verify_backup(output, pg_bin=binaries.directory, environ=env, timeout=60)
        == manifest
    )

    # No existing target, --clean, --create, DROP or primary database is used.
    target = "ca_restore_" + uuid.uuid4().hex
    with connection.cursor() as cursor:
        cursor.execute(
            sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(
                sql.Identifier(target)
            )
        )
    connect = {
        "host": str(socket),
        "port": database["PORT"],
        "user": database["USER"],
        "password": database["PASSWORD"],
        "dbname": target,
        "connect_timeout": 2,
        "sslmode": "disable",
    }
    with psycopg.connect(**connect, autocommit=True) as restored:
        with restored.cursor() as restored_cursor:
            restored_cursor.execute(
                "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'"
            )
            assert restored_cursor.fetchone() == (0,), "Restore target must be empty"
        restored_run = subprocess.run(
            [
                str(binaries.directory / "pg_restore"),
                "--no-password",
                "--exit-on-error",
                "--single-transaction",
                "--no-owner",
                "--no-acl",
                "--dbname",
                target,
                str(output / ARCHIVE),
            ],
            env={**env, "PGDATABASE": target},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )
        assert restored_run.returncode == 0, "Owned application restore failed"
        with restored.cursor() as restored_cursor:

            def one(statement: str, *parameters: Any) -> tuple[Any, ...]:
                restored_cursor.execute(statement, parameters)
                row = restored_cursor.fetchone()
                assert row is not None
                return tuple(row)

            assert one("SELECT count(*) FROM django_migrations") == (migration_count,)
            assert one(
                "SELECT owner_id, workspace_id, name, entrypoint_file_id FROM projects_project WHERE id=%s",
                project.id,
            ) == (
                project.owner_id,
                project.workspace_id,
                project.name,
                project.entrypoint_file_id,
            )
            restored_binary, revision, digest = one(
                "SELECT binary_state, durable_revision, state_sha256 FROM collaboration_documentstate WHERE document_id=%s",
                state.document_id,
            )
            assert bytes(restored_binary) == binary
            assert revision == 7 and digest == state.state_sha256
            assert (
                json.loads(_yjs("decode", base64.b64encode(restored_binary).decode()))
                == source
            )
            assert one(
                "SELECT document_id, durable_revision, observed_counter, state_sha256 FROM collaboration_checkpointreceipt WHERE id=%s",
                receipt.id,
            ) == (state.document_id, 7, 3, state.state_sha256)
            assert one(
                "SELECT assignment_id, assignment_version_id, revision_id, source_manifest_sha256 FROM submissions_submission WHERE id=%s",
                submission.id,
            ) == (
                submission.assignment_id,
                submission.assignment_version_id,
                submission.revision_id,
                submission.source_manifest_sha256,
            )
            assert one(
                "SELECT file_id, document_id, path, source, source_sha256 FROM projects_revisionfile WHERE id=%s",
                frozen.id,
            ) == (
                frozen.file_id,
                frozen.document_id,
                frozen.path,
                frozen.source,
                frozen.source_sha256,
            )
            assert frozen.source != source
            assert one(
                "SELECT submission_id, user_id, participation_id, attempt_number FROM submissions_submissionparticipant WHERE id=%s",
                participant.id,
            ) == (
                submission.id,
                participant.user_id,
                participant.participation_id,
                participant.attempt_number,
            )
            assert one(
                "SELECT submission_id, comments, assessment_status, content_sha256 FROM submissions_feedbackpublication WHERE id=%s",
                publication.id,
            ) == (
                submission.id,
                comments,
                publication.assessment_status,
                publication.content_sha256,
            )
            with pytest.raises(psycopg.errors.CheckViolation) as protected:
                restored_cursor.execute(
                    "UPDATE submissions_feedbackpublication SET comments='forbidden' WHERE id=%s",
                    (publication.id,),
                )
            assert (
                protected.value.diag.constraint_name == "feedback_publication_immutable"
            )
            assert one(
                "SELECT comments FROM submissions_feedbackpublication WHERE id=%s",
                publication.id,
            ) == (comments,)
    # The source database was read, never restored over or drained by this test.
    assert bytes(DocumentState.objects.get(pk=state.pk).binary_state) == binary
    assert FeedbackPublication.objects.get(pk=publication.pk).comments == comments

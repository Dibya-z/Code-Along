"""Actual ProductServer/provider durability across SIGKILL and PostgreSQL WAL replay.

The private admission adapter is an explicit test fixture. Django session/Origin
policy has separate tests; this gate uses its real migrated binary schema and
restricted role rather than the M0 proof tables or reconstructed source text.
"""

import json
import os
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from tools.dev import postgres_cluster as module


def private_json(path: Path, value: object) -> None:
    with os.fdopen(
        os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as out:
        json.dump(value, out, ensure_ascii=False, separators=(",", ":"))


def read_line(process: subprocess.Popen[bytes], timeout: float = 20) -> bytes:
    if process.stdout is None:
        raise AssertionError("Owned product fixture has no control pipe")
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise AssertionError("Owned product fixture did not become ready")
        line = process.stdout.readline(512).strip()
    if not line:
        raise AssertionError("Owned product fixture exited before readiness")
    return line


def stop_child(process: subprocess.Popen[bytes]) -> None:
    try:
        module._stop_owned_process(
            process, stop_signal=signal.SIGTERM, whole_group=True
        )
    finally:
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


@pytest.mark.postgres
def test_product_receipts_and_exact_deletion_state_survive_service_and_database_crashes():
    root = Path(__file__).resolve().parents[2]
    fixtures = root / "apps/collaboration/tests/fixtures"
    server_script = fixtures / "product-crash-server.ts"
    client_script = fixtures / "product-crash-client.ts"
    children: list[subprocess.Popen[bytes]] = []
    with module.postgres_cluster() as cluster:
        env = {
            **cluster.environment(),
            "CODE_ALONG_COLLABORATION_DB_USER": "code_along_collaboration",
            "CODE_ALONG_COLLABORATION_DB_PASSWORD": secrets.token_urlsafe(32),
        }
        seeded = subprocess.run(
            [sys.executable, str(fixtures / "product-schema.py")],
            cwd=root,
            env=env,
            capture_output=True,
            timeout=30,
            check=False,
        )
        assert seeded.returncode == 0, "Actual Django product fixture failed"
        identifiers = json.loads(seeded.stdout)["documents"]
        # These are freshly created example.test fixtures in the owned cluster.
        # Never select account/session secrets or emit source/config/packets.
        rows = json.loads(
            cluster.sql(
                "SELECT json_agg(json_build_object("
                "'document_id',d.id,'project_id',d.project_id,'file_id',f.id,"
                "'generation',d.generation,'initial_source',f.initial_source,"
                "'initial_sha256',f.initial_sha256,'workspace_id',p.workspace_id,"
                "'user_id',p.owner_id))::text FROM projects_collaborationdocument d "
                "JOIN projects_projectfile f ON f.id=d.file_id "
                "JOIN projects_project p ON p.id=d.project_id"
            )
        )
        documents = {row["document_id"]: row for row in rows}
        config: dict[str, list[dict[str, Any]]] = {"before": [], "after": []}
        awareness_ids = secrets.SystemRandom().sample(range(1, 2**32), 4)
        for index, identifier in enumerate(identifiers[:2]):
            document = documents[identifier["document_id"]]
            client_session = str(uuid.uuid4())
            for phase_index, phase in enumerate(("before", "after")):
                config[phase].append(
                    {
                        "ticket": secrets.token_urlsafe(32),
                        "grant": {
                            "version": 1,
                            "lease_id": str(uuid.uuid4()),
                            "lease_token": secrets.token_urlsafe(32),
                            "ttl_ms": 30000,
                            "scope": "write",
                            "client_session_id": client_session,
                            "awareness_client_id": awareness_ids[
                                index * 2 + phase_index
                            ],
                            "workspace_id": document["workspace_id"],
                            "project_id": document["project_id"],
                            "workspace_acl_version": "1",
                            "project_acl_version": "1",
                            "user": {
                                "id": document["user_id"],
                                "display_name": "River",
                                "color": "#2563eb",
                            },
                            "document": {
                                "id": document["document_id"],
                                "file_id": document["file_id"],
                                "generation": document["generation"],
                                "schema_version": 1,
                                "initial_source": document["initial_source"],
                                "initial_sha256": document["initial_sha256"],
                            },
                        },
                    }
                )
        config_path = cluster.directory / "product-crash-config.json"
        private_json(config_path, config)

        def launch(script: Path, phase: str, port: int | None = None):
            args = ["node", str(script), phase, str(config_path)]
            if port is not None:
                args.append(str(port))
            process = subprocess.Popen(
                args,
                cwd=root,
                env=cluster.environment(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            children.append(process)
            return process

        def start_server(phase: str) -> tuple[subprocess.Popen[bytes], int]:
            process = launch(server_script, phase)
            ready = json.loads(read_line(process))
            if (
                set(ready) != {"event", "port"}
                or ready["event"] != "product_server_ready"
                or not isinstance(ready["port"], int)
                or not 1 <= ready["port"] <= 65535
            ):
                raise AssertionError("Unexpected product fixture readiness event")
            return process, ready["port"]

        restarted: subprocess.Popen[bytes] | None = None
        try:
            before_server, port = start_server("before")
            before_client = launch(client_script, "before", port)
            if read_line(before_client) != b"product_checkpoint_committed":
                raise AssertionError(
                    "Provider did not receive committed product receipts"
                )
            packet = cluster.directory / "product-crash-packet.json"
            assert stat.S_IMODE(packet.stat().st_mode) == 0o600
            assert (
                cluster.sql("SELECT count(*) FROM collaboration_checkpointreceipt")
                == "2"
            )
            # Kill the real ProductServer while both admitted providers are live.
            before_server.kill()
            before_server.wait(timeout=10)
            assert before_server.returncode == -signal.SIGKILL
            before_client.communicate(input=b"stop\n", timeout=10)
            assert before_client.returncode == 0, "Before-crash provider cleanup failed"

            # Immediate database shutdown aborts processes without a clean checkpoint.
            cluster.process.send_signal(signal.SIGQUIT)
            cluster.process.wait(timeout=10)
            recovery_path = cluster.directory / "product-recovery.log"
            with os.fdopen(
                os.open(recovery_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                "wb",
            ) as recovery_log:
                restarted = subprocess.Popen(
                    cluster.process.args,
                    env=cluster.environment(),
                    stdin=subprocess.DEVNULL,
                    stdout=recovery_log,
                    stderr=recovery_log,
                    start_new_session=True,
                )
                # Retain the actual new owned-process reference for readiness/cleanup.
                recovered_cluster = replace(cluster, process=restarted)
                module._wait_until_ready(recovered_cluster, 15)
                recovery = recovery_path.read_text()
                assert "database system was interrupted" in recovery
                assert "redo starts at" in recovery and "redo done at" in recovery

                after_server, after_port = start_server("after")
                assert after_server.pid != before_server.pid
                after_client = launch(client_script, "after", after_port)
                output, _ = after_client.communicate(timeout=15)
                if (
                    after_client.returncode != 0
                    or output.strip() != b"product_recovery_verified"
                ):
                    raise AssertionError(
                        "Fresh product/provider binary recovery failed"
                    )
                assert (
                    recovered_cluster.sql(
                        "SELECT count(*) FROM collaboration_checkpointreceipt"
                    )
                    == "2"
                )
                stop_child(after_server)
                assert after_server.returncode == 0
        finally:
            for child in reversed(children):
                stop_child(child)
            if restarted is not None:
                module._stop_owned_process(restarted)
        assert restarted is not None and restarted.poll() == 0
    assert not cluster.directory.exists()

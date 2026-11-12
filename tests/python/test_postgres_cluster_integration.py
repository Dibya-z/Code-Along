import json
import os
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

import pytest

from tools.dev import postgres_cluster as cluster_module
from tools.dev.postgres_cluster import PostgresTestError, main, postgres_cluster

pytestmark = pytest.mark.postgres


def test_real_postgres18_is_private_and_keeps_durability_settings(monkeypatch):
    monkeypatch.setenv("PGHOST", "must-not-connect.example.invalid")
    monkeypatch.setenv("PGDATABASE", "must_not_touch")
    monkeypatch.setenv("PGPASSWORD", "fixture_only_not_a_real_password")
    with postgres_cluster() as cluster:
        settings = cluster.sql(
            "SELECT current_setting('server_version_num'), "
            "current_setting('listen_addresses'), current_setting('fsync'), "
            "current_setting('synchronous_commit'), "
            "current_setting('full_page_writes'), current_user"
        ).split("|")
        assert 180000 <= int(settings[0]) < 190000
        assert settings[1:] == ["", "on", "on", "on", "code_along_test"]
        assert cluster.directory.stat().st_mode & 0o777 == 0o700
        assert cluster.socket_directory.stat().st_mode & 0o777 == 0o700
        assert (cluster.socket_directory / ".s.PGSQL.5432").exists()
        assert "PGPASSWORD" not in cluster.environment()
        root = cluster.directory
        process = cluster.process
    assert process.poll() == 0
    assert not root.exists()
    assert os.environ["PGDATABASE"] == "must_not_touch"


def test_real_transactions_commit_rollback_and_fail_without_echoing_sql():
    with postgres_cluster() as cluster:
        cluster.sql("CREATE TABLE proof (value integer NOT NULL)")
        cluster.sql("BEGIN; INSERT INTO proof VALUES (1); COMMIT")
        cluster.sql("BEGIN; INSERT INTO proof VALUES (2); ROLLBACK")
        assert cluster.sql("SELECT value FROM proof ORDER BY value") == "1"
        with pytest.raises(PostgresTestError, match="query failed") as failure:
            cluster.sql("SELECT PRIVATE_TEST_SOURCE_FROM_MISSING_TABLE")
        assert "PRIVATE_TEST_SOURCE" not in str(failure.value)
        assert cluster.sql("SELECT count(*) FROM proof") == "1"


def test_clusters_do_not_share_tables_or_data_directories():
    with postgres_cluster() as first, postgres_cluster() as second:
        assert first.directory != second.directory
        assert first.socket_directory != second.socket_directory
        first.sql("CREATE TABLE only_first (value integer)")
        assert second.sql("SELECT to_regclass('public.only_first') IS NULL") == "t"
        assert first.sql("SELECT to_regclass('public.only_first') IS NOT NULL") == "t"


def test_cluster_is_stopped_and_removed_after_a_test_exception():
    with pytest.raises(RuntimeError, match="intentional fixture failure"):
        with postgres_cluster() as cluster:
            directory = cluster.directory
            process = cluster.process
            raise RuntimeError("intentional fixture failure")
    assert process.poll() == 0
    assert not directory.exists()


def test_cli_child_receives_only_the_owned_cluster_and_its_exit_status(tmp_path):
    output = tmp_path / "child.json"
    script = (
        "import json,os,sys; from pathlib import Path; "
        "Path(sys.argv[1]).write_text(json.dumps({"
        "k:os.environ[k] for k in ['PGHOST','PGUSER','PGDATABASE']})); "
        "sys.exit(7)"
    )
    assert main(["--", sys.executable, "-c", script, str(output)]) == 7
    environment = json.loads(output.read_text())
    assert environment["PGUSER"] == "code_along_test"
    assert environment["PGDATABASE"] == "postgres"
    assert not Path(environment["PGHOST"]).exists()


def test_missing_child_command_still_cleans_up(tmp_path):
    assert main(["--", str(tmp_path / "does-not-exist")]) == 2


def test_cli_sigterm_cleans_up_the_server(tmp_path):
    marker = tmp_path / "socket.txt"
    stopped = tmp_path / "child-stopped.txt"
    script = "\n".join(
        [
            "import os,sys,time,signal",
            "from pathlib import Path",
            "def stop(*args):",
            "    Path(sys.argv[2]).write_text('stopped')",
            "    sys.exit(0)",
            "signal.signal(signal.SIGTERM, stop)",
            "Path(sys.argv[1]).write_text(os.environ['PGHOST'])",
            "time.sleep(30)",
        ]
    )
    tool = Path(__file__).resolve().parents[2] / "tools/dev/postgres_cluster.py"
    # The wrapper is a separate process group so the test owns every child.
    process = subprocess.Popen(
        [
            sys.executable,
            str(tool),
            "--",
            sys.executable,
            "-c",
            script,
            str(marker),
            str(stopped),
        ],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 15
        while not marker.exists() and time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail("CLI fixture exited before creating its connection marker")
            time.sleep(0.05)
        assert marker.exists(), "CLI fixture did not become ready"
        socket_directory = Path(marker.read_text())
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=15) == 143
        assert stopped.read_text() == "stopped"
        assert not socket_directory.exists()
    finally:
        # Also end the deliberately sleeping trusted child, if it is still alive.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        if process.stderr is not None:
            process.stderr.close()


def test_startup_failure_stops_and_removes_the_owned_cluster(monkeypatch):
    captured = []
    original = cluster_module._wait_until_ready

    def fail_after_startup(cluster, timeout):
        original(cluster, timeout)
        captured.append(cluster)
        raise PostgresTestError("injected readiness failure")

    monkeypatch.setattr(cluster_module, "_wait_until_ready", fail_after_startup)
    with pytest.raises(PostgresTestError, match="injected readiness failure"):
        with postgres_cluster():
            pytest.fail("The injected startup failure must prevent entry")
    assert len(captured) == 1
    assert captured[0].process.poll() == 0
    assert not captured[0].directory.exists()


def test_query_timeout_diagnostics_do_not_echo_sql(monkeypatch):
    with postgres_cluster() as cluster:
        statement = "SELECT PRIVATE_SOURCE_IN_TIMEOUT"

        def timeout(command, **_kwargs):
            raise subprocess.TimeoutExpired(command, timeout=10)

        with monkeypatch.context() as patch:
            patch.setattr(cluster_module.subprocess, "run", timeout)
            with pytest.raises(
                PostgresTestError, match="could not complete"
            ) as failure:
                cluster.sql(statement)
        diagnostic = "".join(traceback.format_exception(failure.value))
        assert "PRIVATE_SOURCE_IN_TIMEOUT" not in diagnostic
        assert failure.value.__suppress_context__ is True

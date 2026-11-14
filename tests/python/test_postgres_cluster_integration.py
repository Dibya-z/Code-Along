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


@pytest.mark.parametrize("connection_budget", [None, 32])
def test_real_postgres18_is_private_and_keeps_durability_settings(
    monkeypatch, connection_budget
):
    monkeypatch.setenv("PGHOST", "must-not-connect.example.invalid")
    monkeypatch.setenv("PGDATABASE", "must_not_touch")
    monkeypatch.setenv("PGPASSWORD", "fixture_only_not_a_real_password")
    options = (
        {} if connection_budget is None else {"max_connections": connection_budget}
    )
    with postgres_cluster(**options) as cluster:
        settings = cluster.sql(
            "SELECT current_setting('server_version_num'), "
            "current_setting('listen_addresses'), current_setting('fsync'), "
            "current_setting('synchronous_commit'), "
            "current_setting('full_page_writes'), current_user, "
            "current_setting('max_connections')"
        ).split("|")
        assert 180000 <= int(settings[0]) < 190000
        assert settings[1:-1] == ["", "on", "on", "on", "code_along_test"]
        assert settings[-1] == str(
            10 if connection_budget is None else connection_budget
        )
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


@pytest.mark.parametrize("mode", ["ready", "startup", "repeat"])
def test_direct_context_sigterm_cleans_up_without_the_cli_wrapper(tmp_path, mode):
    marker = tmp_path / "direct.json"
    script = "\n".join(
        [
            "import json,sys,time",
            "from pathlib import Path",
            "from tools.dev import postgres_cluster as module",
            "def mark(cluster):",
            "    Path(sys.argv[1]).write_text(json.dumps({'pid':cluster.process.pid, 'root':str(cluster.directory), 'bin':str(cluster.binaries.directory)}))",
            "def wait(cluster, timeout):",
            "    mark(cluster)",
            "    time.sleep(60)",
            "original_stop = module._stop_owned_process",
            "def delayed_stop(process):",
            "    Path(sys.argv[1]).with_suffix('.cleanup').touch()",
            "    time.sleep(0.25)",
            "    original_stop(process)",
            "if sys.argv[2] == 'repeat': module._stop_owned_process = delayed_stop",
            "if sys.argv[2] == 'startup': module._wait_until_ready = wait",
            "with module.postgres_cluster() as cluster:",
            "    mark(cluster)",
            "    time.sleep(60)",
        ]
    )
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            script,
            str(marker),
            mode,
        ],
        cwd=Path(__file__).resolve().parents[2],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 20
        while not marker.exists() and time.monotonic() < deadline:
            assert process.poll() is None, "Direct fixture exited before readiness"
            time.sleep(0.05)
        assert marker.exists()
        state = json.loads(marker.read_text())
        process.terminate()
        if mode == "repeat":
            deadline = time.monotonic() + 5
            while (
                not marker.with_suffix(".cleanup").exists()
                and time.monotonic() < deadline
            ):
                time.sleep(0.01)
            assert marker.with_suffix(".cleanup").exists()
            process.terminate()
        assert process.wait(timeout=15) in (130, -signal.SIGINT)
        assert not Path(state["root"]).exists()
        with pytest.raises(ProcessLookupError):
            os.kill(state["pid"], 0)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        # A regression must not make the regression test itself leak a server.
        if marker.exists():
            state = json.loads(marker.read_text())
            data = Path(state["root"]) / "data"
            pid_file = data / "postmaster.pid"
            if (
                pid_file.exists()
                and int(pid_file.read_text().splitlines()[0]) == state["pid"]
            ):
                subprocess.run(
                    [
                        str(Path(state["bin"]) / "pg_ctl"),
                        "-D",
                        str(data),
                        "-m",
                        "fast",
                        "-w",
                        "stop",
                    ],
                    capture_output=True,
                    timeout=15,
                    check=True,
                )


def test_context_restores_default_sigterm_and_preserves_a_custom_handler():
    previous = signal.getsignal(signal.SIGTERM)
    try:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        with postgres_cluster():
            assert callable(signal.getsignal(signal.SIGTERM))
        assert signal.getsignal(signal.SIGTERM) == signal.SIG_DFL

        def caller_handler(_signum, _frame):
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, caller_handler)
        with postgres_cluster():
            assert signal.getsignal(signal.SIGTERM) is caller_handler
        assert signal.getsignal(signal.SIGTERM) is caller_handler
    finally:
        signal.signal(signal.SIGTERM, previous)


def test_pytest_sigterm_stops_the_session_and_cleans_its_fixture(tmp_path):
    marker = tmp_path / "pytest-cluster.json"
    continued = tmp_path / "continued.txt"
    child_test = tmp_path / "test_termination_consumer.py"
    child_test.write_text(
        "\n".join(
            [
                "import json,os,time,pytest",
                "from pathlib import Path",
                "from tools.dev.postgres_cluster import postgres_cluster",
                "@pytest.fixture(scope='session')",
                "def database():",
                "    with postgres_cluster() as cluster:",
                "        yield cluster",
                "def test_wait(database):",
                "    Path(os.environ['CA_TERMINATION_MARKER']).write_text(json.dumps({'pid':database.process.pid,'root':str(database.directory),'bin':str(database.binaries.directory)}))",
                "    time.sleep(60)",
                "def test_must_not_continue():",
                "    Path(os.environ['CA_CONTINUED_MARKER']).touch()",
            ]
        )
    )
    root = Path(__file__).resolve().parents[2]
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "-c",
            str(root / "pyproject.toml"),
            str(child_test),
        ],
        cwd=root,
        env={
            **os.environ,
            "PYTHONPATH": str(root),
            "CA_TERMINATION_MARKER": str(marker),
            "CA_CONTINUED_MARKER": str(continued),
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 20
        while not marker.exists() and time.monotonic() < deadline:
            assert process.poll() is None, "Pytest consumer exited before readiness"
            time.sleep(0.05)
        assert marker.exists()
        state = json.loads(marker.read_text())
        process.terminate()
        assert process.wait(timeout=15) == 2  # Pytest's interrupted-session status.
        assert not continued.exists()
        assert not Path(state["root"]).exists()
        with pytest.raises(ProcessLookupError):
            os.kill(state["pid"], 0)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if marker.exists():
            state = json.loads(marker.read_text())
            data = Path(state["root"]) / "data"
            pid_file = data / "postmaster.pid"
            if (
                pid_file.exists()
                and int(pid_file.read_text().splitlines()[0]) == state["pid"]
            ):
                subprocess.run(
                    [
                        str(Path(state["bin"]) / "pg_ctl"),
                        "-D",
                        str(data),
                        "-m",
                        "fast",
                        "-w",
                        "stop",
                    ],
                    capture_output=True,
                    timeout=15,
                    check=True,
                )

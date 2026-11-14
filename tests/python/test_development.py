"""Lifecycle/ownership checks; no Docker engine or existing database is used."""

import json
import signal
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.dev import development as module


def lima_fixture(root: Path) -> module.Engine:
    path = root / ".runtime/tools/lima/bin/limactl"
    path.parent.mkdir(parents=True)
    path.touch()
    configuration = root / ".runtime/lima/code-along/lima.yaml"
    configuration.parent.mkdir(parents=True)
    configuration.write_text("# owned test fixture\n")
    return module.Engine(root)


def test_origin_uses_only_validated_public_port_and_never_sources_environment(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("CODE_ALONG_HTTPS_PORT", raising=False)
    (tmp_path / ".env").write_text(
        "CODE_ALONG_SECRET_KEY=private_fixture\nCODE_ALONG_HTTPS_PORT='9443'\nIGNORED=$(touch must-not-execute)\n"
    )
    assert module.app_origin(tmp_path) == "https://127.0.0.1:9443"
    monkeypatch.setenv("CODE_ALONG_HTTPS_PORT", "10443")
    assert module.app_origin(tmp_path) == "https://127.0.0.1:10443"
    assert not (tmp_path / "must-not-execute").exists()


@pytest.mark.parametrize("value", ["", "0", "65536", "-1", "8443;bad", "not-a-port"])
def test_invalid_port_fails_before_starting_services(tmp_path, monkeypatch, value):
    monkeypatch.setenv("CODE_ALONG_HTTPS_PORT", value)
    with pytest.raises(module.DevelopmentError, match="port number"):
        module.app_origin(tmp_path)


def test_compose_targets_only_this_project_and_owned_lima_namespace(
    tmp_path, monkeypatch
):
    engine = lima_fixture(tmp_path)
    monkeypatch.setenv("LIMA_HOME", "/must-not-use-global-lima")
    monkeypatch.setenv("CODE_ALONG_HTTPS_PORT", "9443")
    calls = []

    def run(command, **options):
        calls.append((command, options))
        return SimpleNamespace(returncode=0, stdout="status")

    monkeypatch.setattr(module.subprocess, "run", run)
    assert engine.compose(["ps", "-a"], capture=True) == "status"
    command, options = calls[0]
    assert command[:2] == [str(engine.lima), "shell"]
    assert "--start" not in command
    assert command[command.index("--workdir") + 1] == str(tmp_path)
    assert command[command.index("-p") + 1] == "code-along-dev"
    assert "CODE_ALONG_HTTPS_PORT=9443" in command
    assert command[-2:] == ["ps", "-a"]
    assert options["env"]["LIMA_HOME"] == str(tmp_path / ".runtime/lima")
    engine.compose(["up", "--build", "-d"], start=True)
    assert "--start" in calls[1][0]
    assert "--volumes" not in calls[1][0]


def test_running_status_never_starts_a_stopped_vm(tmp_path, monkeypatch):
    engine = lima_fixture(tmp_path)
    calls = []

    def run(command, **options):
        calls.append(command)
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({"name": "code-along", "status": "Stopped"})
        )

    monkeypatch.setattr(module.subprocess, "run", run)
    assert not engine.running()
    assert calls == [[str(engine.lima), "list", "--json", "code-along"]]


def test_project_lock_prevents_duplicate_controllers_and_is_released(tmp_path):
    with module.controller_lock(tmp_path):
        with pytest.raises(module.DevelopmentBusy):
            with module.controller_lock(tmp_path):
                pytest.fail("A second controller must not acquire the lock")
    with module.controller_lock(tmp_path):
        pass


def test_lima_shutdown_runs_even_when_docker_stop_fails(tmp_path, monkeypatch):
    engine = lima_fixture(tmp_path)
    calls = []
    monkeypatch.setattr(module.Engine, "lima_status", lambda self: "Running")

    def compose(self, arguments, **kwargs):
        assert arguments == ["stop"]
        raise module.DevelopmentError("injected Docker shutdown failure")

    monkeypatch.setattr(module.Engine, "compose", compose)
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **kwargs: (
            calls.append(command) or SimpleNamespace(returncode=0)
        ),
    )
    with pytest.raises(module.DevelopmentError, match="shutdown failure"):
        engine.stop()
    assert calls == [[str(engine.lima), "stop", "code-along"]]


@pytest.mark.parametrize("failure", ["", "build", "readiness"])
def test_controller_shuts_down_on_stop_request_or_failure(
    tmp_path, monkeypatch, failure
):
    calls = []
    previous = signal.getsignal(signal.SIGTERM)

    class FakeEngine:
        root = tmp_path

        def compose(self, arguments, **kwargs):
            calls.append((arguments, kwargs))
            if failure == "build":
                raise module.DevelopmentError("injected build failure")
            (tmp_path / ".runtime/development.stop").touch()

        def stop(self):
            calls.append("stop")

    monkeypatch.setattr(module, "initialize", lambda: None)

    def readiness(engine):
        if failure == "readiness":
            raise module.DevelopmentError("injected readiness failure")

    monkeypatch.setattr(module, "wait_ready", readiness)
    if failure:
        with pytest.raises(module.DevelopmentError, match="injected"):
            module.dev(FakeEngine())
    else:
        module.dev(FakeEngine())
    assert calls[0] == (["up", "--build", "-d"], {"start": True})
    assert calls[-1] == "stop"
    assert signal.getsignal(signal.SIGTERM) == previous
    assert not (tmp_path / ".runtime/development.stop").exists()
    with module.controller_lock(tmp_path):
        pass


@pytest.mark.parametrize("missing", ["collaboration", "jobs", "scheduler"])
def test_controller_stops_owned_stack_when_a_background_service_exits(
    tmp_path, monkeypatch, missing
):
    stopped = []
    ticks = iter([0, 6])

    class FakeEngine:
        root = tmp_path

        def compose(self, arguments, **kwargs):
            if arguments[0] == "ps":
                services = {
                    "api",
                    "db",
                    "redis",
                    "proxy",
                    "web-dev",
                    "collaboration",
                    "jobs",
                    "scheduler",
                }
                return "\n".join(sorted(services - {missing}))
            return ""

        def stop(self):
            stopped.append(True)

    monkeypatch.setattr(module, "initialize", lambda: None)
    monkeypatch.setattr(module, "wait_ready", lambda engine: None)
    monkeypatch.setattr(
        module,
        "time",
        SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None),
    )
    with pytest.raises(module.DevelopmentError, match="service exited"):
        module.dev(FakeEngine())
    assert stopped == [True]
    with module.controller_lock(tmp_path):
        pass


def test_mail_requires_explicit_latest_and_ignores_unsafe_filenames(tmp_path, capsys):
    calls = []

    class FakeEngine:
        root = tmp_path

        def running(self):
            return True

        def compose(self, arguments, **kwargs):
            calls.append(arguments)
            return "20261114-2.log\n../escape.log\nnot-a-message\n20261113-1.log\n"

    engine = FakeEngine()
    module.mail(engine, latest=False)
    assert len(calls) == 1
    assert "2 local message(s)" in capsys.readouterr().out
    module.mail(engine, latest=True)
    assert calls[-1] == ["exec", "-T", "api", "cat", "/app/dev-mail/20261114-2.log"]


def test_stop_propagates_service_failure_without_retrying_as_a_busy_lock(tmp_path):
    class FakeEngine:
        root = tmp_path

        def stop(self):
            raise module.DevelopmentError("injected stop failure")

    with pytest.raises(module.DevelopmentError, match="stop failure"):
        module.stop(FakeEngine())


@pytest.mark.parametrize("stop_signal", [signal.SIGINT, signal.SIGTERM, signal.SIGHUP])
def test_foreground_controller_cleans_up_on_terminal_signals(tmp_path, stop_signal):
    import os
    import subprocess
    import sys
    import time

    marker = tmp_path / "ready.txt"
    stopped = tmp_path / "stopped.txt"
    script = "\n".join(
        [
            "import sys; from pathlib import Path",
            "from tools.dev import development as module",
            "root = Path(sys.argv[1])",
            "module.initialize = lambda: None",
            "module.wait_ready = lambda engine: None",
            "class Engine:",
            "    def __init__(self): self.root = root",
            "    def compose(self, arguments, **kwargs):",
            "        (root / 'ready.txt').touch()",
            "        return 'api\\ndb\\nredis\\nproxy\\nweb-dev\\ncollaboration\\njobs\\nscheduler'",
            "    def stop(self): (root / 'stopped.txt').touch()",
            "module.dev(Engine())",
        ]
    )
    root = Path(__file__).resolve().parents[2]
    child = subprocess.Popen(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=root,
        env={**os.environ, "PYTHONPATH": str(root)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 10
        while not marker.exists() and time.monotonic() < deadline:
            assert child.poll() is None
            time.sleep(0.02)
        assert marker.exists()
        child.send_signal(stop_signal)
        assert child.wait(timeout=10) == 0
        assert stopped.exists()
        with module.controller_lock(tmp_path):
            pass
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_test_project_transport_cannot_start_or_stop_any_stack(tmp_path):
    engine = lima_fixture(tmp_path)
    for project, arguments in [
        ("unrelated", ["port", "proxy", "8443"]),
        ("code-along-ci", ["stop"]),
        ("code-along-dev-check", ["up", "--build", "-d"]),
    ]:
        with pytest.raises(module.DevelopmentError):
            engine.compose(arguments, project=project)


def test_stopping_an_already_stopped_vm_succeeds_without_another_shutdown(
    tmp_path, monkeypatch
):
    engine = lima_fixture(tmp_path)
    monkeypatch.setattr(module.Engine, "lima_status", lambda self: "Stopped")

    def unexpected(*args, **kwargs):
        pytest.fail("An already stopped VM must not receive another shutdown")

    monkeypatch.setattr(module.subprocess, "run", unexpected)
    engine.stop()
    engine.stop()


def test_shutdown_race_is_success_when_the_vm_is_already_stopped(tmp_path, monkeypatch):
    engine = lima_fixture(tmp_path)
    states = iter(["Running", "Stopped"])
    monkeypatch.setattr(module.Engine, "lima_status", lambda self: next(states))
    monkeypatch.setattr(module.Engine, "compose", lambda *args, **kwargs: "")
    monkeypatch.setattr(
        module.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1)
    )
    engine.stop()


def test_failed_vm_shutdown_is_reported_when_it_stays_running(tmp_path, monkeypatch):
    engine = lima_fixture(tmp_path)
    monkeypatch.setattr(module.Engine, "lima_status", lambda self: "Running")
    monkeypatch.setattr(module.Engine, "compose", lambda *args, **kwargs: "")
    monkeypatch.setattr(
        module.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=1)
    )
    with pytest.raises(module.DevelopmentError, match="Could not stop"):
        engine.stop()


def test_remote_docker_context_is_rejected_before_service_commands(
    tmp_path, monkeypatch
):
    engine = module.Engine(tmp_path)
    monkeypatch.setenv("DOCKER_HOST", "ssh://not-a-local-development-engine")
    monkeypatch.setattr(module.shutil, "which", lambda name: "/fixture/docker")
    with pytest.raises(module.DevelopmentError, match="local Docker Unix socket"):
        engine.compose(["stop"])


def test_local_docker_socket_is_accepted_without_changing_context(
    tmp_path, monkeypatch
):
    engine = module.Engine(tmp_path)
    monkeypatch.setenv("DOCKER_HOST", "unix:///fixture/docker.sock")
    engine.require_local_docker()


def test_start_requires_the_existing_owned_vm_configuration(tmp_path):
    engine = lima_fixture(tmp_path)
    (tmp_path / ".runtime/lima/code-along/lima.yaml").unlink()
    with pytest.raises(module.DevelopmentError, match="configuration is missing"):
        engine.compose(["up", "--build", "-d"], start=True)

"""Repeated fixture termination must still release its real private database."""

import os
import runpy
import signal
import subprocess
from contextlib import contextmanager
from pathlib import Path

import pytest

from tools.dev.postgres_cluster import postgres_cluster


@pytest.mark.postgres
def test_native_shutdown_ignores_repeated_signals_until_database_cleanup(monkeypatch):
    root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(root / "tools/dev"))
    namespace = runpy.run_path(str(root / "tools/dev/run_native.py"))
    main = namespace["main"]
    observed = []
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}

    @contextmanager
    def owned_cluster():
        with postgres_cluster() as cluster:
            observed.append(cluster)
            yield cluster

    original_spawn = subprocess.Popen
    original_run = subprocess.run
    original_sleep = main.__globals__["time"].sleep

    class Child:
        stopped = False

        def poll(self):
            return 0 if self.stopped else None

        def terminate(self):
            self.stopped = True

        def wait(self, **_kwargs):
            os.kill(os.getpid(), signal.SIGTERM)
            os.kill(os.getpid(), signal.SIGINT)
            return 0

    def spawn(command, **kwargs):
        if any(
            "redis" in str(part)
            or "daphne" in str(part)
            or "native_proxy.py" in str(part)
            for part in command
        ):
            return Child()
        return original_spawn(command, **kwargs)

    def run(command, **kwargs):
        if "apps/api/manage.py" in command:
            return subprocess.CompletedProcess(command, 0)
        return original_run(command, **kwargs)

    def interrupt(seconds):
        if observed:
            os.kill(os.getpid(), signal.SIGTERM)
        else:
            original_sleep(seconds)

    monkeypatch.setenv("CODE_ALONG_REDIS_BIN", "/fixture/redis-server")
    monkeypatch.setitem(main.__globals__, "postgres_cluster", owned_cluster)
    monkeypatch.setattr(subprocess, "Popen", spawn)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(main.__globals__["time"], "sleep", interrupt)
    main()
    assert observed[0].process.poll() == 0
    assert not observed[0].directory.exists()
    assert all(signal.getsignal(sig) == handler for sig, handler in previous.items())

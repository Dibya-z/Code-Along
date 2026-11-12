"""Real binary checkpoint recovery, not a reconstructed in-memory store."""

import signal
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest

from tools.dev import postgres_cluster as module


@pytest.mark.postgres
def test_committed_binary_state_and_idempotency_survive_database_immediate_restart():
    root = Path(__file__).resolve().parents[2]
    probe = root / "apps/collaboration/tests/fixtures/restart-probe.ts"
    with module.postgres_cluster() as cluster:
        packet = cluster.directory / "packet.json"

        def run_phase(phase):
            result = subprocess.run(
                ["node", str(probe), phase, str(packet)],
                cwd=root,
                env=cluster.environment(),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            # Never include raw driver/SQL/source diagnostics on failure.
            assert result.returncode == 0, "Checkpoint recovery probe failed"
            return result.stdout.strip()

        run_phase("before")
        # SIGQUIT is PostgreSQL immediate shutdown: abort backends and replay WAL
        # on restart, without leaving an unowned replacement/background daemon.
        cluster.process.send_signal(signal.SIGQUIT)
        cluster.process.wait(timeout=10)
        restarted = subprocess.Popen(
            cluster.process.args,
            env=cluster.environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            module._wait_until_ready(replace(cluster, process=restarted), 15)
            assert run_phase("after") == "checkpoint_recovery_verified"
        finally:
            module._stop_owned_process(restarted)
        assert restarted.poll() == 0
    assert not cluster.directory.exists()

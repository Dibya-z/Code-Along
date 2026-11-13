"""Owned, disposable native development stack. Ctrl-C stops all owned services.

Requires matching PG18 tools, Redis 8, installed workspace and built web/runner.
User data is intentionally disposable here; Compose provides persistent volumes.
"""

from __future__ import annotations

import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path

from postgres_cluster import postgres_cluster

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    redis = os.environ.get("CODE_ALONG_REDIS_BIN") or shutil.which("redis-server")
    if not redis:
        raise SystemExit("Set CODE_ALONG_REDIS_BIN to a trusted Redis 8 executable.")
    children: list[subprocess.Popen[bytes]] = []
    previous_signals = {
        sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)
    }

    def protect_cleanup() -> None:
        # Playwright may signal the process group repeatedly during shutdown.
        # Do not interrupt the ExitStack before its private PostgreSQL exits.
        for sig in previous_signals:
            signal.signal(sig, signal.SIG_IGN)

    def cleanup() -> None:
        protect_cleanup()
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    def stop(*_args: object) -> None:
        protect_cleanup()
        raise KeyboardInterrupt

    for sig in previous_signals:
        signal.signal(sig, stop)
    try:
        with ExitStack() as stack:
            cluster = stack.enter_context(postgres_cluster())
            stack.callback(cleanup)
            socket = cluster.directory / "redis.sock"
            log = stack.enter_context((cluster.directory / "native.log").open("wb"))

            def spawn(
                command: list[str], env: dict[str, str]
            ) -> subprocess.Popen[bytes]:
                child = subprocess.Popen(
                    command,
                    cwd=ROOT,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                )
                children.append(child)
                return child

            env = {
                k: v
                for k, v in cluster.environment().items()
                if not k.startswith("CODE_ALONG_")
            }
            https_port = os.environ.get("CODE_ALONG_HTTPS_PORT", "8443")
            env.update(
                DJANGO_SETTINGS_MODULE="config.settings.development",
                CODE_ALONG_DEBUG="false",
                CODE_ALONG_SECRET_KEY=secrets.token_urlsafe(64),
                CODE_ALONG_ALLOWED_HOSTS="127.0.0.1,localhost",
                CODE_ALONG_DB_NAME="postgres",
                CODE_ALONG_DB_USER="code_along_test",
                CODE_ALONG_DB_PASSWORD="",
                CODE_ALONG_DB_HOST=str(cluster.socket_directory),
                CODE_ALONG_REDIS_URL=f"unix://{socket}",
                CODE_ALONG_TRUST_PROXY="true",
                CODE_ALONG_HTTPS_PORT=https_port,
                CODE_ALONG_APP_ORIGIN=f"https://127.0.0.1:{https_port}",
            )
            # Private file mail spool is enabled by the account milestone.
            env["CODE_ALONG_MAIL_DIR"] = str(ROOT / ".runtime/mail")
            spawn(
                [
                    redis,
                    "--port",
                    "0",
                    "--unixsocket",
                    str(socket),
                    "--unixsocketperm",
                    "700",
                    "--save",
                    "",
                    "--appendonly",
                    "no",
                ],
                env,
            )
            result = subprocess.run(
                [sys.executable, "apps/api/manage.py", "migrate", "--noinput"],
                cwd=ROOT,
                env=env,
                stdout=log,
                stderr=log,
            )
            if result.returncode:
                raise RuntimeError("Owned native migration failed")
            api_port = env["CODE_ALONG_NATIVE_API_PORT"] = os.environ.get(
                "CODE_ALONG_NATIVE_API_PORT", "18000"
            )
            spawn(
                [
                    str(ROOT / ".venv/bin/daphne"),
                    "-b",
                    "127.0.0.1",
                    "-p",
                    api_port,
                    "config.asgi:application",
                ],
                {**env, "PYTHONPATH": str(ROOT / "apps/api")},
            )
            proxy = spawn([sys.executable, "tools/dev/native_proxy.py"], env)
            print(
                f"Code Along native development: https://127.0.0.1:{https_port} (disposable database)",
                flush=True,
            )
            while proxy.poll() is None:
                if any(c.poll() is not None for c in children):
                    raise RuntimeError("An owned development service exited")
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            cleanup()
        finally:
            for sig, previous in previous_signals.items():
                signal.signal(sig, previous)


if __name__ == "__main__":
    main()

import json
import os
import secrets
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import cast
from urllib.error import URLError
from urllib.request import urlopen

import pytest

API_ROOT = Path(__file__).resolve().parents[2]


def child_environment() -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("CODE_ALONG_", "PG", "DJANGO_"))
    }
    env.update(
        CODE_ALONG_SECRET_KEY=secrets.token_urlsafe(64),
        CODE_ALONG_ALLOWED_HOSTS="127.0.0.1,localhost",
        CODE_ALONG_DB_NAME="code_along",
        CODE_ALONG_DB_USER="code_along",
        CODE_ALONG_DB_PASSWORD=secrets.token_urlsafe(32),
        # Deliberately non-connectable. Liveness must not need the database.
        CODE_ALONG_DB_HOST="/nonexistent/code-along-startup-test",
    )
    return env


def inspect_settings(env: dict[str, str], *, development: bool) -> dict[str, object]:
    env = {
        **env,
        "DJANGO_SETTINGS_MODULE": f"config.settings.{'development' if development else 'production'}",
    }
    script = """import json,django
django.setup()
from django.conf import settings as s
print(json.dumps({name:getattr(s,name) for name in [
'DEBUG','ALLOWED_HOSTS','AUTH_USER_MODEL','ASGI_APPLICATION',
'SESSION_COOKIE_NAME','SESSION_COOKIE_SECURE','SESSION_COOKIE_HTTPONLY',
'SESSION_COOKIE_DOMAIN','CSRF_COOKIE_NAME','CSRF_COOKIE_SECURE','CSRF_COOKIE_DOMAIN',
'CSRF_TRUSTED_ORIGINS','SECURE_SSL_REDIRECT','SECURE_PROXY_SSL_HEADER','CHANNEL_LAYERS','EMAIL_BACKEND']}))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=API_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, "Settings inspection failed"
    return cast(dict[str, object], json.loads(result.stdout))


def test_production_uses_host_only_secure_cookies_and_no_implicit_proxy_trust() -> None:
    s = inspect_settings(child_environment(), development=False)
    assert s["AUTH_USER_MODEL"] == "accounts.User"
    assert s["ASGI_APPLICATION"] == "config.asgi.application"
    assert s["DEBUG"] is False and s["SECURE_SSL_REDIRECT"] is True
    assert str(s["SESSION_COOKIE_NAME"]).startswith("__Host-")
    assert str(s["CSRF_COOKIE_NAME"]).startswith("__Host-")
    assert s["SESSION_COOKIE_SECURE"] and s["CSRF_COOKIE_SECURE"]
    assert s["SESSION_COOKIE_HTTPONLY"] is True
    assert s["SESSION_COOKIE_DOMAIN"] is None and s["CSRF_COOKIE_DOMAIN"] is None
    assert s["CSRF_TRUSTED_ORIGINS"] == []
    assert s["SECURE_PROXY_SSL_HEADER"] is None
    assert s["CHANNEL_LAYERS"] == {}
    assert s["EMAIL_BACKEND"] == "django.core.mail.backends.smtp.EmailBackend"


def test_development_explicitly_allows_local_http() -> None:
    s = inspect_settings(child_environment(), development=True)
    assert s["DEBUG"] is True and s["SECURE_SSL_REDIRECT"] is False
    assert not s["SESSION_COOKIE_SECURE"] and not s["CSRF_COOKIE_SECURE"]


@pytest.mark.parametrize("entrypoint", ["manage", "asgi"])
def test_default_entrypoints_fail_closed_without_a_secret(entrypoint: str) -> None:
    env = child_environment()
    secret = env.pop("CODE_ALONG_SECRET_KEY")
    command = (
        [str(API_ROOT / "manage.py"), "check"]
        if entrypoint == "manage"
        else ["-c", "import config.asgi"]
    )
    result = subprocess.run(
        [sys.executable, *command],
        cwd=API_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0
    assert "CODE_ALONG_SECRET_KEY must be explicitly configured" in result.stderr
    assert secret not in result.stdout + result.stderr
    assert env["CODE_ALONG_DB_PASSWORD"] not in result.stdout + result.stderr


@contextmanager
def running_server() -> Iterator[tuple[str, subprocess.Popen[bytes]]]:
    # Parent owns an ephemeral loopback socket and passes it directly to Daphne.
    # There is no find-free-port race, shared service or fixed application port.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)
        port = listener.getsockname()[1]
        env = {
            **child_environment(),
            "DJANGO_SETTINGS_MODULE": "config.settings.development",
        }
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "from daphne.cli import CommandLineInterface; CommandLineInterface.entrypoint()",
                "--fd",
                str(listener.fileno()),
                "config.asgi:application",
            ],
            cwd=API_ROOT,
            env=env,
            pass_fds=(listener.fileno(),),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 10
            url = f"http://127.0.0.1:{port}/health/live/"
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    pytest.fail("Owned ASGI server exited before readiness")
                try:
                    with urlopen(url, timeout=0.2) as response:
                        if response.status == 200:
                            break
                except (URLError, TimeoutError, OSError):
                    time.sleep(0.05)
            else:
                pytest.fail("Owned ASGI server did not become ready")
            yield url, process
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def test_real_daphne_serves_liveness_without_a_database_and_stops_cleanly() -> None:
    with running_server() as (url, process):
        with urlopen(url, timeout=2) as response:
            assert response.status == 200
            assert json.load(response) == {"status": "ok"}
            assert response.headers["Cache-Control"] == "no-store"
    assert process.poll() is not None

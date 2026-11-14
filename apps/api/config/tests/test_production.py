import os
import secrets
import subprocess
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import Client, override_settings

from config.production import production_host, production_settings

ROOT = Path(__file__).resolve().parents[4]


def valid_environment() -> dict[str, str]:
    return {
        "CODE_ALONG_APP_ORIGIN": "https://learn.example.com",
        "CODE_ALONG_RUNNER_ORIGIN": "https://python.example.net",
        "CODE_ALONG_ALLOWED_HOSTS": "learn.example.com,api",
        "CODE_ALONG_TRUST_PROXY": "true",
        "CODE_ALONG_DB_SSLROOTCERT": "/run/certs/postgres-ca.pem",
        "CODE_ALONG_REDIS_URL": "redis://redis:6379/0",
        "CODE_ALONG_CELERY_BROKER_URL": "redis://redis:6379/2",
        "CODE_ALONG_COLLABORATION_SECRET": secrets.token_urlsafe(48),
        "CODE_ALONG_COLLABORATION_CONTROL_SECRET": secrets.token_urlsafe(48),
        "CODE_ALONG_COLLABORATION_CONTROL_URL": "http://collaboration:1234",
        "CODE_ALONG_SMTP_HOST": "smtp.example.com",
        "CODE_ALONG_SMTP_USER": "smtp-user",
        "CODE_ALONG_SMTP_PASSWORD": secrets.token_urlsafe(32),
        "CODE_ALONG_FROM_EMAIL": "Code Along <noreply@example.com>",
    }


def test_production_requires_independent_sites_and_staged_hsts() -> None:
    values = production_settings(valid_environment())
    assert values["SECURE_HSTS_SECONDS"] == 3600
    assert values["SECURE_HSTS_INCLUDE_SUBDOMAINS"] is False
    assert values["SECURE_HSTS_PRELOAD"] is False


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "http://learn.example.com",
        "https://learn.example.com/",
        "https://learn.example.com:443",
        "https://learn.example.com:8443",
        "https://LEARN.example.com",
        "https://learn.example.com/path",
        "https://learn.example.com?token=private",
        "https://name:private@learn.example.com",
        "https://learn.example.com\n",
        "https://127.0.0.1",
        "https://localhost",
        "https://app.localhost",
        "https://[::1]",
    ],
)
def test_production_origin_fails_closed_without_echoing(origin: str) -> None:
    with pytest.raises(ImproperlyConfigured) as error:
        production_host(origin)
    assert "token=private" not in str(error.value)
    assert "name:private" not in str(error.value)


@pytest.mark.parametrize(
    "origin",
    [
        "https://runner.example.com",
        "https://learn.example.com",
        "https://other.learn.example.com",
        "https://example.com",
    ],
)
def test_same_site_runner_is_rejected(origin: str) -> None:
    env = {**valid_environment(), "CODE_ALONG_RUNNER_ORIGIN": origin}
    with pytest.raises(ImproperlyConfigured, match="different final two"):
        production_settings(env)


@pytest.mark.parametrize("name", list(valid_environment()))
def test_missing_required_production_inputs_fail_safely(name: str) -> None:
    env = valid_environment()
    env.pop(name)
    with pytest.raises(ImproperlyConfigured) as error:
        production_settings(env)
    assert env.get("CODE_ALONG_SMTP_PASSWORD", "not-in-the-message") not in str(
        error.value
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("CODE_ALONG_ALLOWED_HOSTS", "*"),
        ("CODE_ALONG_ALLOWED_HOSTS", "learn.example.com,python.example.net,api"),
        ("CODE_ALONG_ALLOWED_HOSTS", "learn.example.com"),
        ("CODE_ALONG_TRUST_PROXY", "false"),
        ("CODE_ALONG_SMTP_HOST", "smtp://private@example.com"),
        ("CODE_ALONG_FROM_EMAIL", "not-a-mailbox"),
        ("CODE_ALONG_FROM_EMAIL", "hello@example.com\nBcc: private@example.net"),
        ("CODE_ALONG_DB_SSLROOTCERT", "relative/ca.pem"),
        ("CODE_ALONG_DB_SSLROOTCERT", "/run/../private/ca.pem"),
        ("CODE_ALONG_SMTP_PASSWORD", "replace-with-a-secret"),
        ("CODE_ALONG_COLLABORATION_SECRET", "replace-with-a-generated-secret"),
    ],
)
def test_unsafe_production_inputs_are_rejected(name: str, value: str) -> None:
    with pytest.raises(ImproperlyConfigured):
        production_settings({**valid_environment(), name: value})


def test_https_redirect_preserves_private_admission_and_public_boundary() -> None:
    config = production_settings(valid_environment())
    with override_settings(
        SECURE_SSL_REDIRECT=True,
        SECURE_REDIRECT_EXEMPT=config["SECURE_REDIRECT_EXEMPT"],
    ):
        client = Client()
        assert client.get("/health/live/").status_code == 200
        assert (
            client.post("/internal/v1/collaboration/consume/", data={}).status_code
            == 403
        )
        assert (
            client.post("/internal/v1/collaboration/renew/", data={}).status_code == 403
        )
        assert client.get("/api/v1/csrf/").status_code == 301
        assert client.get("/internal/v1/collaboration/consume/extra").status_code == 301


@pytest.mark.parametrize(
    ("app", "runner", "allowed"),
    [
        ("https://learn.example.com", "https://python.example.net", True),
        ("https://learn.example.com", "https://python.example.com", False),
        ("https://learn.example.com/path", "https://python.example.net", False),
        ("https://learn.example.com", "https://python.example.net?x=1", False),
        ("https://learn.example.com", "https://python.example.net:8443", False),
        ("https://learn.example.com", "https://127.0.0.1", False),
        ("https://learn.example.com", "https://runner.localhost", False),
        ("https://learn.example.com", "https://python.example.net\n", False),
    ],
)
def test_actual_proxy_entrypoint_validates_before_rendering(
    app: str, runner: str, allowed: bool
) -> None:
    script = ROOT / "infra/proxy/production-start.sh"
    assert script.is_file()
    result = subprocess.run(
        ["sh", str(script), "--check"],
        env={**os.environ, "APP_ORIGIN": app, "RUNNER_ORIGIN": runner},
        capture_output=True,
        timeout=3,
        check=False,
    )
    assert (result.returncode == 0) is allowed
    assert result.stdout == b""

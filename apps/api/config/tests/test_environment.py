import secrets
from dataclasses import asdict

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.environment import load_environment


def valid_environment() -> dict[str, str]:
    return {
        "CODE_ALONG_SECRET_KEY": secrets.token_urlsafe(64),
        "CODE_ALONG_ALLOWED_HOSTS": "api.codealong.test",
        "CODE_ALONG_DB_NAME": "code_along",
        "CODE_ALONG_DB_USER": "code_along",
        "CODE_ALONG_DB_PASSWORD": secrets.token_urlsafe(32),
        "CODE_ALONG_DB_HOST": "db.codealong.test",
    }


def test_production_is_secure_by_default_and_repr_hides_secrets() -> None:
    env = valid_environment()
    config = load_environment(env, development=False)
    assert config.debug is False
    assert config.database.sslmode == "verify-full"
    assert config.allowed_hosts == ("api.codealong.test",)
    for secret in (env["CODE_ALONG_SECRET_KEY"], env["CODE_ALONG_DB_PASSWORD"]):
        assert secret not in repr(config)
    assert config.database.django_settings()["CONN_MAX_AGE"] == 0


@pytest.mark.parametrize(
    "name",
    ["SECRET_KEY", "ALLOWED_HOSTS", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_HOST"],
)
def test_missing_production_configuration_fails_without_echoing_values(
    name: str,
) -> None:
    env = valid_environment()
    original_secret = env["CODE_ALONG_SECRET_KEY"]
    env.pop(f"CODE_ALONG_{name}")
    with pytest.raises(ImproperlyConfigured) as failure:
        load_environment(env, development=False)
    assert original_secret not in str(failure.value)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("SECRET_KEY", "short"),
        ("SECRET_KEY", "x" * 64),
        ("SECRET_KEY", "django-insecure-" + "abC123" * 12),
        ("SECRET_KEY", "replace-with-generated-secret-" + "abC123" * 12),
        ("DEBUG", "true"),
        ("DEBUG", "yes"),
        ("ALLOWED_HOSTS", "*"),
        ("ALLOWED_HOSTS", "https://api.codealong.test"),
        ("ALLOWED_HOSTS", "api.codealong.test:8000"),
        ("ALLOWED_HOSTS", "api.codealong.test,"),
        ("ALLOWED_HOSTS", ".codealong.test"),
        ("DB_HOST", "postgres://private-user:private-password@host/db"),
        ("DB_NAME", "code_along; DROP TABLE accounts_user"),
        ("DB_USER", " invalid "),
        ("DB_PORT", "0"),
        ("DB_PORT", "65536"),
        ("DB_PORT", "5432.0"),
        ("DB_PORT", "-1"),
        ("DB_PORT", "５４３２"),
        ("DB_SSLMODE", "disable"),
        ("DB_SSLMODE", "require"),
        ("DB_SSLMODE", "unknown"),
    ],
)
def test_invalid_production_configuration_fails_safely(name: str, value: str) -> None:
    env = {**valid_environment(), f"CODE_ALONG_{name}": value}
    with pytest.raises(ImproperlyConfigured) as failure:
        load_environment(env, development=False)
    for key in ("CODE_ALONG_SECRET_KEY", "CODE_ALONG_DB_PASSWORD"):
        if len(env[key]) >= 30:
            assert env[key] not in str(failure.value)
    if "@" in value:
        assert value not in str(failure.value)
    assert failure.value.__cause__ is None


def test_development_has_explicit_local_http_and_private_socket_support() -> None:
    env = valid_environment()
    env.pop("CODE_ALONG_ALLOWED_HOSTS")
    env.pop("CODE_ALONG_DB_PASSWORD")
    env["CODE_ALONG_DB_HOST"] = "/tmp/private-socket"
    config = load_environment(env, development=True)
    assert config.debug is True
    assert config.allowed_hosts == ("localhost", "127.0.0.1", "[::1]")
    assert config.database.password == ""
    assert config.database.sslmode == "disable"


def test_explicit_false_is_not_treated_as_truthy() -> None:
    config = load_environment(
        {**valid_environment(), "CODE_ALONG_DEBUG": "false"}, development=True
    )
    assert config.debug is False


def test_inherited_libpq_environment_cannot_select_the_application_database() -> None:
    env = valid_environment()
    expected = asdict(load_environment(env, development=True))
    env.update(
        PGHOST="must-not-connect.invalid", PGDATABASE="unrelated", PGUSER="other"
    )
    assert asdict(load_environment(env, development=True)) == expected


def test_database_ipv6_is_passed_to_libpq_without_url_brackets() -> None:
    config = load_environment(
        {**valid_environment(), "CODE_ALONG_DB_HOST": "[::1]"}, development=True
    )
    assert config.database.host == "::1"

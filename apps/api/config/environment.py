"""Validate deployment inputs without connecting to services or reading .env files."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from django.core.exceptions import ImproperlyConfigured

_IDENTIFIER = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}\Z")
_HOST_LABEL = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\Z")


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "")
    if not value or value != value.strip() or "\0" in value:
        raise ImproperlyConfigured(f"{name} must be explicitly configured.")
    return value


def valid_host(value: str) -> bool:
    if not value or len(value) > 253:
        return False
    if value.startswith("[") and value.endswith("]"):
        try:
            ipaddress.IPv6Address(value[1:-1])
        except ipaddress.AddressValueError:
            return False
        return True
    return all(_HOST_LABEL.fullmatch(part) for part in value.split("."))


@dataclass(frozen=True)
class DatabaseEnvironment:
    name: str
    user: str
    host: str
    port: int
    sslmode: str
    password: str = field(repr=False)

    def django_settings(self) -> dict[str, Any]:
        return {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": self.name,
            "USER": self.user,
            "PASSWORD": self.password,
            "HOST": self.host,
            "PORT": self.port,
            # Django recommends disabling persistent connections under ASGI.
            "CONN_MAX_AGE": 0,
            "OPTIONS": {"connect_timeout": 5, "sslmode": self.sslmode},
        }


@dataclass(frozen=True)
class RuntimeEnvironment:
    debug: bool
    allowed_hosts: tuple[str, ...]
    database: DatabaseEnvironment
    secret_key: str = field(repr=False)


def load_environment(
    environ: Mapping[str, str], *, development: bool
) -> RuntimeEnvironment:
    secret = _required(environ, "CODE_ALONG_SECRET_KEY")
    if (
        len(secret) < 50
        or len(set(secret)) < 8
        or secret.startswith("django-insecure-")
        or any(word in secret.lower() for word in ("replace-with", "change-me"))
    ):
        raise ImproperlyConfigured(
            "CODE_ALONG_SECRET_KEY must be a non-placeholder secret of at least 50 characters."
        )
    debug_value = environ.get("CODE_ALONG_DEBUG", "true" if development else "false")
    if debug_value not in ("true", "false") or (
        not development and debug_value != "false"
    ):
        raise ImproperlyConfigured(
            "CODE_ALONG_DEBUG must be true/false; production requires false."
        )
    hosts_value = environ.get(
        "CODE_ALONG_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]" if development else ""
    )
    hosts = tuple(part.strip() for part in hosts_value.split(","))
    if not all(valid_host(host) for host in hosts):
        raise ImproperlyConfigured(
            "CODE_ALONG_ALLOWED_HOSTS requires exact hostnames without schemes, ports or wildcards."
        )
    name = _required(environ, "CODE_ALONG_DB_NAME")
    user = _required(environ, "CODE_ALONG_DB_USER")
    if not _IDENTIFIER.fullmatch(name) or not _IDENTIFIER.fullmatch(user):
        raise ImproperlyConfigured(
            "CODE_ALONG_DB_NAME and CODE_ALONG_DB_USER must be PostgreSQL identifiers."
        )
    db_host = _required(environ, "CODE_ALONG_DB_HOST")
    if not db_host.startswith("/") and not valid_host(db_host):
        raise ImproperlyConfigured(
            "CODE_ALONG_DB_HOST must be a hostname or absolute Unix-socket directory."
        )
    if db_host.startswith("[") and db_host.endswith("]"):
        db_host = db_host[1:-1]  # libpq expects IPv6 without URL brackets.
    port = environ.get("CODE_ALONG_DB_PORT", "5432")
    if not port.isascii() or not port.isdecimal() or len(port) > 5:
        raise ImproperlyConfigured("CODE_ALONG_DB_PORT must be between 1 and 65535.")
    port_number = int(port)
    if not 1 <= port_number <= 65535:
        raise ImproperlyConfigured("CODE_ALONG_DB_PORT must be between 1 and 65535.")
    password = environ.get("CODE_ALONG_DB_PASSWORD", "")
    if "\0" in password:
        raise ImproperlyConfigured("CODE_ALONG_DB_PASSWORD must not contain NUL.")
    if not password and not (development and db_host.startswith("/")):
        raise ImproperlyConfigured("CODE_ALONG_DB_PASSWORD must be configured.")
    sslmode = environ.get(
        "CODE_ALONG_DB_SSLMODE", "disable" if development else "verify-full"
    )
    if sslmode not in ("disable", "verify-full") or (
        not development and sslmode != "verify-full"
    ):
        raise ImproperlyConfigured(
            "CODE_ALONG_DB_SSLMODE must be disable/verify-full; production requires verify-full."
        )
    return RuntimeEnvironment(
        secret_key=secret,
        debug=debug_value == "true",
        allowed_hosts=tuple(dict.fromkeys(hosts)),
        database=DatabaseEnvironment(
            name=name,
            user=user,
            host=db_host,
            port=port_number,
            password=password,
            sslmode=sslmode,
        ),
    )

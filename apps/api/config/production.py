"""Required inputs for the single-host production profile; never connect on import."""

import re
from collections.abc import Mapping
from email.utils import parseaddr
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.core.validators import validate_email

from config.environment import valid_host


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name, "")
    if not value or value != value.strip() or any(ord(c) < 32 for c in value):
        raise ImproperlyConfigured(f"{name} must be explicitly configured.")
    return value


def production_host(origin: str) -> str:
    """Conservative DNS-only, standard-port HTTPS origins for the pilot profile."""
    try:
        parsed = urlsplit(origin)
        host = parsed.hostname or ""
        labels = host.split(".")
        if (
            origin != f"https://{host}"
            or not valid_host(host)
            or len(labels) < 2
            or not re.fullmatch(r"[a-z][a-z0-9-]*[a-z0-9]|[a-z]{2}", labels[-1])
            or labels[-1] == "localhost"
        ):
            raise ValueError
    except ValueError:
        raise ImproperlyConfigured(
            "Production origins require canonical HTTPS DNS names without ports."
        ) from None
    return host


def production_settings(environ: Mapping[str, str]) -> dict[str, object]:
    app = production_host(_required(environ, "CODE_ALONG_APP_ORIGIN"))
    runner = production_host(_required(environ, "CODE_ALONG_RUNNER_ORIGIN"))
    # Different final two labels guarantee different registrable sites without
    # shipping a stale public-suffix list. This intentionally rejects some valid
    # ccTLD/private-suffix combinations; choose unambiguous separate sites.
    if app.split(".")[-2:] == runner.split(".")[-2:]:
        raise ImproperlyConfigured(
            "Application and runner require different final two hostname labels."
        )
    hosts = {
        value.strip()
        for value in _required(environ, "CODE_ALONG_ALLOWED_HOSTS").split(",")
    }
    if hosts != {app, "api"}:
        raise ImproperlyConfigured(
            "Production allowed hosts must contain only the app DNS name and api."
        )
    host = _required(environ, "CODE_ALONG_SMTP_HOST")
    if not valid_host(host):
        raise ImproperlyConfigured("CODE_ALONG_SMTP_HOST requires an exact hostname.")
    for name in (
        "CODE_ALONG_SMTP_USER",
        "CODE_ALONG_SMTP_PASSWORD",
        "CODE_ALONG_REDIS_URL",
        "CODE_ALONG_CELERY_BROKER_URL",
        "CODE_ALONG_COLLABORATION_SECRET",
        "CODE_ALONG_COLLABORATION_CONTROL_SECRET",
        "CODE_ALONG_COLLABORATION_CONTROL_URL",
    ):
        if _required(environ, name).lower().startswith("replace-with"):
            raise ImproperlyConfigured(f"{name} must not contain a placeholder.")
    sender = _required(environ, "CODE_ALONG_FROM_EMAIL")
    try:
        _, address = parseaddr(sender, strict=True)
        validate_email(address)
    except (ValueError, ValidationError):
        raise ImproperlyConfigured(
            "CODE_ALONG_FROM_EMAIL requires a valid sender mailbox."
        ) from None
    ca = _required(environ, "CODE_ALONG_DB_SSLROOTCERT")
    if not PurePosixPath(ca).is_absolute() or ".." in PurePosixPath(ca).parts:
        raise ImproperlyConfigured(
            "CODE_ALONG_DB_SSLROOTCERT requires an absolute CA-file path."
        )
    if environ.get("CODE_ALONG_TRUST_PROXY") != "true":
        raise ImproperlyConfigured(
            "The production profile requires its explicitly trusted private proxy."
        )
    return {
        "SECURE_HSTS_SECONDS": 3600,
        "SECURE_HSTS_INCLUDE_SUBDOMAINS": False,
        "SECURE_HSTS_PRELOAD": False,
        # These paths are private bearer-authenticated service calls, or contain
        # no user data. Public Nginx refuses /internal/ entirely.
        "SECURE_REDIRECT_EXEMPT": [
            r"^health/(?:live|ready)/$",
            r"^internal/v1/collaboration/(?:consume|renew)/$",
        ],
    }

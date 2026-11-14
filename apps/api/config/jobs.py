"""Validate the private notification broker without connecting or reflecting it."""

from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from .environment import valid_host


def job_settings(environ: Mapping[str, str]) -> dict[str, object]:
    value = environ.get("CODE_ALONG_CELERY_BROKER_URL", "")
    if not value:
        return {"CELERY_BROKER_URL": None}
    try:
        if any(ord(character) <= 32 or ord(character) == 127 for character in value):
            raise ValueError
        parsed = urlsplit(value)
        if parsed.fragment:
            raise ValueError
        if parsed.scheme == "redis+socket":
            valid = (
                not parsed.netloc
                and parsed.path.startswith("/")
                and parsed.path != "/"
                and parsed.query == "virtual_host=2"
            )
        else:
            hostname = parsed.hostname or ""
            valid = (
                parsed.scheme in {"redis", "rediss"}
                and valid_host(f"[{hostname}]" if ":" in hostname else hostname)
                and parsed.path == "/2"
                and not parsed.query
                and (parsed.port is None or 1 <= parsed.port <= 65535)
            )
        if not valid:
            raise ValueError
    except ValueError:
        raise ImproperlyConfigured(
            "CODE_ALONG_CELERY_BROKER_URL requires an explicit Redis database-2 URL."
        ) from None
    return {"CELERY_BROKER_URL": value}

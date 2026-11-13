from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured


def collaboration_settings(environ: Mapping[str, str]) -> dict[str, object]:
    result: dict[str, object] = {}
    for suffix in ("SECRET", "CONTROL_SECRET"):
        name = f"CODE_ALONG_COLLABORATION_{suffix}"
        value = environ.get(name, "")
        if value and (
            not 32 <= len(value) <= 256 or any(not "!" <= c <= "~" for c in value)
        ):
            raise ImproperlyConfigured(
                f"{name} requires 32–256 printable ASCII characters without whitespace."
            )
        result[f"COLLABORATION_{suffix}"] = value
    if (
        result["COLLABORATION_SECRET"]
        and result["COLLABORATION_SECRET"] == result["COLLABORATION_CONTROL_SECRET"]
    ):
        raise ImproperlyConfigured(
            "Collaboration service and control secrets must differ."
        )
    url = environ.get("CODE_ALONG_COLLABORATION_CONTROL_URL", "")
    if url:
        try:
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.query
                or parsed.fragment
                or any(c.isspace() for c in url)
                or parsed.port is not None
                and not 1 <= parsed.port <= 65535
            ):
                raise ValueError
        except ValueError:
            raise ImproperlyConfigured(
                "Configure an exact private collaboration control origin."
            ) from None
    result["COLLABORATION_CONTROL_URL"] = url
    return result

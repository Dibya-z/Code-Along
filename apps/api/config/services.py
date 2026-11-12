"""Explicit transient-service/proxy settings shared by HTTP and ASGI processes."""

from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured


def service_settings(environ: Mapping[str, str]) -> dict[str, object]:
    trust = environ.get("CODE_ALONG_TRUST_PROXY", "false")
    if trust not in {"true", "false"}:
        raise ImproperlyConfigured("CODE_ALONG_TRUST_PROXY requires true/false.")
    result: dict[str, object] = {
        "SECURE_PROXY_SSL_HEADER": ("HTTP_X_FORWARDED_PROTO", "https")
        if trust == "true"
        else None,
        "REDIS_CONNECTION_SECRET": None,
    }
    value = environ.get("CODE_ALONG_REDIS_URL", "")
    if value:
        try:
            parsed = urlsplit(value)
            valid = (
                parsed.scheme == "unix"
                and parsed.path.startswith("/")
                and not parsed.netloc
            ) or (parsed.scheme in {"redis", "rediss"} and bool(parsed.hostname))
            if not valid or parsed.query or parsed.fragment:
                raise ValueError
            if parsed.port is not None and not 1 <= parsed.port <= 65535:
                raise ValueError
            if parsed.scheme != "unix" and parsed.path not in {"", "/0"}:
                raise ValueError
        except ValueError:
            raise ImproperlyConfigured(
                "CODE_ALONG_REDIS_URL requires a valid Redis database-0 URL."
            ) from None
        result["CACHES"] = {
            "default": {
                "BACKEND": "django.core.cache.backends.redis.RedisCache",
                "LOCATION": value,
                "KEY_PREFIX": "code_along",
                "TIMEOUT": 300,
            }
        }
        result["REDIS_CONNECTION_SECRET"] = value
        result["CHANNEL_LAYERS"] = {
            "default": {
                "BACKEND": "channels_redis.core.RedisChannelLayer",
                "CONFIG": {"hosts": [value]},
            }
        }
    return result

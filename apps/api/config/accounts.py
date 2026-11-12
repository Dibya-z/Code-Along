"""Account origins and mail transports are explicit; production sends via SMTP only."""

from collections.abc import Mapping
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from config.environment import valid_host


def account_settings(
    environ: Mapping[str, str], *, production: bool
) -> dict[str, object]:
    origin = environ.get(
        "CODE_ALONG_APP_ORIGIN", "" if production else "https://127.0.0.1:8443"
    )
    if origin:
        try:
            parsed = urlsplit(origin)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or not valid_host(
                    f"[{parsed.hostname}]"
                    if ":" in parsed.hostname
                    else parsed.hostname
                )
                or any(c in origin for c in "\r\n\t")
                or parsed.username
                or parsed.password
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.port is not None
                and not 1 <= parsed.port <= 65535
            ):
                raise ValueError
        except ValueError:
            raise ImproperlyConfigured(
                "CODE_ALONG_APP_ORIGIN requires an exact HTTPS origin."
            ) from None
    result: dict[str, object] = {
        "PUBLIC_APP_ORIGIN": origin,
        "HEADLESS_FRONTEND_URLS": {
            "account_confirm_email": f"{origin}/auth/verify?key={{key}}",
            "account_reset_password_from_key": f"{origin}/auth/reset?key={{key}}",
            "account_reset_password": f"{origin}/auth/forgot",
            "account_signup": f"{origin}/auth/signup",
            "account_login": f"{origin}/login",
        },
        "ALLAUTH_TRUSTED_PROXY_COUNT": 1
        if environ.get("CODE_ALONG_TRUST_PROXY") == "true"
        else 0,
    }
    if production:
        port = environ.get("CODE_ALONG_SMTP_PORT", "587")
        if not port.isdecimal() or not 1 <= int(port) <= 65535:
            raise ImproperlyConfigured("CODE_ALONG_SMTP_PORT requires a valid port.")
        result.update(
            EMAIL_BACKEND="django.core.mail.backends.smtp.EmailBackend",
            EMAIL_HOST=environ.get("CODE_ALONG_SMTP_HOST", ""),
            EMAIL_PORT=int(port),
            EMAIL_HOST_USER=environ.get("CODE_ALONG_SMTP_USER", ""),
            EMAIL_HOST_PASSWORD=environ.get("CODE_ALONG_SMTP_PASSWORD", ""),
            EMAIL_USE_TLS=True,
            EMAIL_TIMEOUT=10,
            DEFAULT_FROM_EMAIL=environ.get("CODE_ALONG_FROM_EMAIL", ""),
        )
    elif directory := environ.get("CODE_ALONG_MAIL_DIR"):
        if not directory.startswith("/"):
            raise ImproperlyConfigured(
                "CODE_ALONG_MAIL_DIR requires an absolute private path."
            )
        result.update(
            EMAIL_BACKEND="django.core.mail.backends.filebased.EmailBackend",
            EMAIL_FILE_PATH=directory,
        )
    return result

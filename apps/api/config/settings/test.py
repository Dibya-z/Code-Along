"""Tests only. pytest replaces this non-connectable DB with an owned PG18 cluster."""

import secrets

from .base import *  # noqa: F403

SECRET_KEY = secrets.token_urlsafe(64)
DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "not_configured",
        "HOST": "/nonexistent/code-along-test-database",
        "USER": "not_configured",
        "PORT": 5432,
        "CONN_MAX_AGE": 0,
        "OPTIONS": {"connect_timeout": 1, "sslmode": "disable"},
        "TEST": {"NAME": "test_code_along_api"},
    }
}
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = False
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"

from config.accounts import account_settings  # noqa: E402

globals().update(
    account_settings({"CODE_ALONG_APP_ORIGIN": "https://testserver"}, production=False)
)

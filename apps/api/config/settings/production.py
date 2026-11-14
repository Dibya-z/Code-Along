import os

from config.accounts import account_settings
from config.environment import load_environment
from config.production import production_settings
from config.services import service_settings

from .base import *  # noqa: F403
from .base import REST_FRAMEWORK as BASE_REST_FRAMEWORK

_environment = load_environment(os.environ, development=False)
SECRET_KEY = _environment.secret_key
DEBUG = False
ALLOWED_HOSTS = list(_environment.allowed_hosts)
DATABASES = {"default": _environment.database.django_settings()}
SESSION_COOKIE_NAME = "__Host-codealong_session"
CSRF_COOKIE_NAME = "__Host-codealong_csrf"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = True
globals().update(service_settings(os.environ))
globals().update(account_settings(os.environ, production=True))
globals().update(production_settings(os.environ))
DATABASES["default"]["OPTIONS"]["sslrootcert"] = os.environ["CODE_ALONG_DB_SSLROOTCERT"]

REST_FRAMEWORK = {
    **BASE_REST_FRAMEWORK,
    "NUM_PROXIES": 1 if os.environ.get("CODE_ALONG_TRUST_PROXY") == "true" else 0,
}

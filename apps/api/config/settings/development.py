import os

from config.accounts import account_settings
from config.environment import load_environment
from config.services import service_settings

from .base import *  # noqa: F403

_environment = load_environment(os.environ, development=True)
SECRET_KEY = _environment.secret_key
DEBUG = _environment.debug
ALLOWED_HOSTS = list(_environment.allowed_hosts)
DATABASES = {"default": _environment.database.django_settings()}
SESSION_COOKIE_NAME = "codealong_session"
CSRF_COOKIE_NAME = "codealong_csrf"
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
globals().update(service_settings(os.environ))
globals().update(account_settings(os.environ, production=False))

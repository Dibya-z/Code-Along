from typing import cast

from allauth.account.adapter import DefaultAccountAdapter
from django.conf import settings
from django.contrib.auth.base_user import AbstractBaseUser
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.forms.forms import BaseForm
from django.http import HttpRequest

from .managers import UserManager
from .models import User


class AccountAdapter(DefaultAccountAdapter):
    def clean_email(self, email: str) -> str:
        try:
            return UserManager.normalize_email(email)
        except ValueError as error:
            raise ValidationError(
                "Enter a valid email address.", code="invalid"
            ) from error

    def save_user(
        self,
        request: HttpRequest,
        user: AbstractBaseUser,
        form: BaseForm,
        commit: bool = True,
    ) -> User:
        account = cast(User, user)
        account.display_name = str(form.cleaned_data["display_name"]).strip()
        super().save_user(request, account, form, commit=commit)
        return account

    def send_mail(
        self, template_prefix: str, email: str, context: dict[str, object]
    ) -> None:
        if not settings.PUBLIC_APP_ORIGIN:
            raise ImproperlyConfigured(
                "Configure the public application origin before sending account mail."
            )
        if settings.EMAIL_BACKEND == "django.core.mail.backends.smtp.EmailBackend" and (
            not settings.EMAIL_HOST or not settings.DEFAULT_FROM_EMAIL
        ):
            raise ImproperlyConfigured(
                "Configure SMTP host and sender before sending account mail."
            )
        super().send_mail(template_prefix, email, context)

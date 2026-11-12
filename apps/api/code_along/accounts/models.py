from __future__ import annotations

import uuid
from typing import Any

from django.contrib.auth.base_user import AbstractBaseUser
from django.contrib.auth.models import PermissionsMixin
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models.functions import Lower, Trim
from django.utils import timezone

from .managers import UserManager


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    email = models.EmailField(max_length=254, unique=True)
    display_name = models.CharField(max_length=80)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    date_joined = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["display_name"]

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(email=Lower(Trim("email"))) & ~models.Q(email=""),
                name="accounts_user_email_normalized",
            ),
            # Manager/save canonicalization plus an ASCII DB boundary makes
            # identity independent of the deployment database's case collation.
            models.CheckConstraint(
                condition=models.Q(email__regex=r"^[ -~]+$"),
                name="accounts_user_email_ascii",
            ),
            models.CheckConstraint(
                condition=~models.Q(display_name__regex=r"^\s*$"),
                name="accounts_user_display_name_nonblank",
            ),
        ]

    def clean(self) -> None:
        super().clean()
        try:
            self.email = UserManager.normalize_email(self.email)
        except ValueError:
            raise ValidationError(
                {"email": "A valid email address is required."}
            ) from None

    def save(self, *args: Any, **kwargs: Any) -> None:
        self.email = UserManager.normalize_email(self.email)
        super().save(*args, **kwargs)

    def get_full_name(self) -> str:
        return self.display_name

    def get_short_name(self) -> str:
        return self.display_name

    def __str__(self) -> str:
        # Do not use email as a public display name or routine object log label.
        return self.display_name

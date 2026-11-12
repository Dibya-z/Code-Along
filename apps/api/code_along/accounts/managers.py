from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.contrib.auth.base_user import BaseUserManager
from django.core.exceptions import ValidationError
from django.core.validators import validate_email


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    @classmethod
    def normalize_email(cls, email: str | None) -> str:
        """Case-insensitive identity; Unicode domains become canonical ASCII IDNA."""
        if not email:
            return ""
        try:
            local, domain = email.strip().rsplit("@", 1)
            normalized = (
                f"{local.lower()}@{domain.encode('idna').decode('ascii').lower()}"
            )
            if not normalized.isascii() or len(normalized) > 254:
                raise ValueError
            validate_email(normalized)
        except (ValueError, UnicodeError, ValidationError):
            raise ValueError("A valid email address is required.") from None
        return normalized

    def get_by_natural_key(self, username: str | None) -> User:
        try:
            email = self.normalize_email(username)
        except ValueError:
            raise self.model.DoesNotExist from None
        return self.get(email=email)

    async def aget_by_natural_key(self, username: str | None) -> User:
        try:
            email = self.normalize_email(username)
        except ValueError:
            raise self.model.DoesNotExist from None
        return await self.aget(email=email)

    def _create_user(
        self, email: str, display_name: str, password: str | None, **extra_fields: Any
    ) -> User:
        email = self.normalize_email(email)
        if not email:
            raise ValueError("An email address is required.")
        display_name = display_name.strip()
        if not display_name or len(display_name) > 80:
            raise ValueError("A display name of 1 to 80 characters is required.")
        user = self.model(email=email, display_name=display_name, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(
        self,
        email: str,
        display_name: str,
        password: str | None = None,
        **extra_fields: Any,
    ) -> User:
        extra_fields.setdefault("is_staff", False)
        extra_fields.setdefault("is_superuser", False)
        return self._create_user(email, display_name, password, **extra_fields)

    def create_superuser(
        self,
        email: str,
        display_name: str,
        password: str | None = None,
        **extra_fields: Any,
    ) -> User:
        extra_fields.setdefault("is_staff", True)
        extra_fields.setdefault("is_superuser", True)
        if (
            extra_fields["is_staff"] is not True
            or extra_fields["is_superuser"] is not True
        ):
            raise ValueError(
                "A superuser must have is_staff=True and is_superuser=True."
            )
        if not password:
            raise ValueError("A superuser requires a usable password.")
        return self._create_user(email, display_name, password, **extra_fields)


# The model imports its manager, so runtime import must remain one-way.
if TYPE_CHECKING:
    from .models import User

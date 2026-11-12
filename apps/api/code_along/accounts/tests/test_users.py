import asyncio
import secrets
import uuid

import pytest
from asgiref.sync import sync_to_async
from django.contrib.auth import authenticate, get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connections, transaction
from django.utils import timezone

from code_along.accounts.models import User

pytestmark = [pytest.mark.django_db, pytest.mark.postgres]


def test_custom_identity_and_password_use_the_framework() -> None:
    password = secrets.token_urlsafe(32)
    user = User.objects.create_user(" Learner@EXAMPLE.COM ", " Ada ", password)
    assert get_user_model() is User
    assert isinstance(user.id, uuid.UUID)
    assert user.email == "learner@example.com"
    assert user.display_name == "Ada"
    assert user.password != password
    assert user.check_password(password)
    assert user.is_active and not user.is_staff and not user.is_superuser
    assert timezone.is_aware(user.date_joined)
    assert timezone.is_aware(user.updated_at)
    assert str(user) == "Ada" and user.email not in str(user)
    assert authenticate(email="LEARNER@example.com", password=password) == user
    assert authenticate(email=user.email, password="incorrect") is None
    assert authenticate(email="not-an-email", password=password) is None


def test_email_uniqueness_is_case_insensitive_and_database_enforced() -> None:
    original = User.objects.create_user("Ada@example.com", "Ada")
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create_user("ADA@EXAMPLE.COM", "Another Ada")
    assert User.objects.count() == 1
    original.refresh_from_db()
    assert original.email == "ada@example.com"


def test_direct_save_normalizes_and_database_blocks_bypassing_canonical_identity() -> (
    None
):
    user = User(email="Mixed@EXAMPLE.COM", display_name="Mixed")
    user.set_unusable_password()
    user.save()
    assert user.email == "mixed@example.com"
    for value in ("MIXED@example.com", " mixed@example.com", "", "other@ÉXAMPLE.com"):
        with pytest.raises(IntegrityError), transaction.atomic():
            User.objects.filter(pk=user.pk).update(email=value)
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.filter(pk=user.pk).update(display_name="   ")


def test_international_domain_is_canonical_idna() -> None:
    user = User.objects.create_user("Learner@BÜCHER.example", "Learner")
    assert user.email == "learner@xn--bcher-kva.example"
    assert User.objects.get_by_natural_key("LEARNER@bücher.example") == user
    with pytest.raises(IntegrityError), transaction.atomic():
        User.objects.create_user("learner@xn--bcher-kva.example", "Duplicate")


@pytest.mark.parametrize("email", ["", "not-an-email", "a@", "é@example.com"])
def test_invalid_email_is_rejected_before_a_user_is_created(email: str) -> None:
    with pytest.raises(ValueError):
        User.objects.create_user(email, "Learner")
    assert not User.objects.exists()


@pytest.mark.parametrize("name", ["", " \t ", "x" * 81])
def test_invalid_display_name_is_rejected(name: str) -> None:
    with pytest.raises(ValueError):
        User.objects.create_user("learner@example.com", name)
    assert not User.objects.exists()


def test_passwordless_user_has_no_usable_password() -> None:
    user = User.objects.create_user("learner@example.com", "Learner")
    assert not user.has_usable_password()


def test_invalid_email_uses_framework_validation_during_full_clean() -> None:
    user = User(email="invalid", display_name="Learner")
    with pytest.raises(ValidationError) as failure:
        user.full_clean()
    assert "email" in failure.value.message_dict


def test_inactive_account_cannot_authenticate() -> None:
    password = secrets.token_urlsafe(32)
    user = User.objects.create_user(
        "inactive@example.com", "Inactive", password, is_active=False
    )
    assert authenticate(email=user.email, password=password) is None


def test_superuser_manager_sets_only_framework_administrative_flags() -> None:
    user = User.objects.create_superuser(
        "admin@example.com", "Administrator", secrets.token_urlsafe(32)
    )
    assert user.is_staff and user.is_superuser and user.has_usable_password()
    assert not hasattr(user, "workspace_role")


@pytest.mark.parametrize("flags", [{"is_staff": False}, {"is_superuser": False}])
def test_invalid_superuser_flags_are_rejected(flags: dict[str, bool]) -> None:
    with pytest.raises(ValueError):
        User.objects.create_superuser(
            "admin@example.com", "Administrator", secrets.token_urlsafe(32), **flags
        )
    assert not User.objects.exists()


def test_superuser_requires_a_password() -> None:
    with pytest.raises(ValueError):
        User.objects.create_superuser("admin@example.com", "Administrator")
    assert not User.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_async_natural_key_uses_the_same_normalization() -> None:
    user = User.objects.create_user("async@example.com", "Async")

    async def check() -> None:
        try:
            found = await User.objects.aget_by_natural_key(" ASYNC@EXAMPLE.COM ")
            assert found.id == user.id
            with pytest.raises(User.DoesNotExist):
                await User.objects.aget_by_natural_key("invalid")
        finally:
            await sync_to_async(connections.close_all, thread_sensitive=True)()

    asyncio.run(check())

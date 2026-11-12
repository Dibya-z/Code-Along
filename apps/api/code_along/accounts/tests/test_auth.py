from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from django.test.client import _MonkeyPatchedWSGIResponse

import re
import time
from datetime import datetime, timedelta
from unittest.mock import patch
from urllib.parse import unquote

import pytest
from allauth.account.models import EmailAddress
from django.conf import settings
from django.core import mail
from django.core.cache import cache
from django.test import Client, override_settings

from code_along.accounts.models import User

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]
BASE = "/api/v1/auth/browser/v1/auth/"
PASSWORD = "river-orbit-copper-84!"


@pytest.fixture(autouse=True)
def reset_limits() -> None:
    cache.clear()


def post(
    client: Client, action: str, body: dict[str, object]
) -> _MonkeyPatchedWSGIResponse:
    return client.post(
        BASE + action, body, content_type="application/json", secure=True
    )


def signup(
    client: Client, email: str = "learner@example.test"
) -> _MonkeyPatchedWSGIResponse:
    return post(
        client,
        "signup",
        {"email": email, "display_name": "River", "password": PASSWORD},
    )


def email_key(kind: str) -> str:
    assert len(mail.outbox) > 0
    matches = re.findall(
        r"https://testserver/auth/" + kind + r"\?key=([^\s]+)",
        str(mail.outbox[-1].body),
    )
    assert matches, "Expected private test email link"
    return unquote(str(matches[0]))


def verified_user(email: str = "river@example.test") -> User:
    user = User.objects.create_user(email, password=PASSWORD, display_name="River")
    EmailAddress.objects.create(
        user=user, email=user.email, primary=True, verified=True
    )
    return user


def test_signup_requires_verification_and_saves_profile_before_insert(
    client: Client,
) -> None:
    response = signup(client, " Learner@Example.test ")
    assert response.status_code == 401
    user = User.objects.get(email="learner@example.test")
    assert user.display_name == "River" and user.check_password(PASSWORD)
    assert not EmailAddress.objects.get(user=user).verified
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    key = email_key("verify")
    assert key not in response.content.decode()
    assert post(client, "email/verify", {"key": key}).status_code in {200, 401}
    assert EmailAddress.objects.get(user=user).verified
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    assert (
        post(client, "login", {"email": user.email, "password": PASSWORD}).status_code
        == 200
    )
    assert client.get("/api/v1/me/", secure=True).json() == {
        "id": str(user.id),
        "email": user.email,
        "display_name": "River",
    }


@pytest.mark.parametrize(
    "body",
    [
        {"email": "bad", "display_name": "River", "password": PASSWORD},
        {"email": "a@example.test", "display_name": " ", "password": PASSWORD},
        {"email": "a@example.test", "display_name": "x" * 81, "password": PASSWORD},
        {"email": "a@example.test", "display_name": "River", "password": "password"},
    ],
)
def test_signup_rejects_invalid_profile_and_weak_password(
    client: Client, body: dict[str, object]
) -> None:
    assert post(client, "signup", body).status_code == 400
    assert not User.objects.exists()


def test_duplicate_signup_does_not_disclose_account(client: Client) -> None:
    verified_user("learner@example.test")
    response = signup(client)
    assert response.status_code == 401
    assert User.objects.count() == 1
    assert "already" not in response.content.decode().lower()


def test_unverified_inactive_and_wrong_password_cannot_access_product(
    client: Client,
) -> None:
    user = User.objects.create_user(
        "learner@example.test", password=PASSWORD, display_name="River"
    )
    EmailAddress.objects.create(
        user=user, email=user.email, primary=True, verified=False
    )
    assert (
        post(client, "login", {"email": user.email, "password": PASSWORD}).status_code
        == 401
    )
    client.force_login(user)
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    user.is_active = False
    user.save()
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    client.logout()
    assert (
        post(client, "login", {"email": user.email, "password": "wrong"}).status_code
        == 400
    )


def test_session_rotates_on_login_is_host_only_and_logout_invalidates(
    client: Client,
) -> None:
    user = verified_user()
    session = client.session
    session["probe"] = True
    session.save()
    old = session.session_key
    response = post(
        client, "login", {"email": user.email.upper(), "password": PASSWORD}
    )
    assert response.status_code == 200
    cookie = response.cookies[settings.SESSION_COOKIE_NAME]
    assert (
        cookie["httponly"]
        and cookie["secure"]
        and cookie["samesite"] == "Lax"
        and cookie["domain"] == ""
    )
    assert client.session.session_key != old
    session_key = client.session.session_key
    assert session_key is not None
    assert (
        client.delete(
            BASE + "session", content_type="application/json", secure=True
        ).status_code
        == 401
    )
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    other = Client()
    other.cookies[settings.SESSION_COOKIE_NAME] = session_key
    assert other.get("/api/v1/me/", secure=True).status_code == 403


def test_password_reset_is_generic_one_use_and_invalidates_other_sessions(
    client: Client,
) -> None:
    user = verified_user()
    other = Client()
    assert (
        post(other, "login", {"email": user.email, "password": PASSWORD}).status_code
        == 200
    )
    known = post(client, "password/request", {"email": user.email})
    key = email_key("reset")
    unknown = post(Client(), "password/request", {"email": "unknown@example.test"})
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()
    assert key not in known.content.decode()
    response = post(
        client, "password/reset", {"key": key, "password": "new-copper-moon-92!"}
    )
    assert response.status_code in {200, 401}
    user.refresh_from_db()
    assert user.check_password("new-copper-moon-92!")
    assert other.get("/api/v1/me/", secure=True).status_code == 403
    assert (
        post(
            client,
            "password/reset",
            {"key": key, "password": "another-copper-moon-93!"},
        ).status_code
        == 400
    )


def test_expired_and_invalid_email_verification_keys_are_rejected(
    client: Client,
) -> None:
    signup(client)
    key = email_key("verify")
    with patch("django.core.signing.time.time", return_value=time.time() + 90000):
        assert post(client, "email/verify", {"key": key}).status_code == 400
    assert post(client, "email/verify", {"key": "invalid"}).status_code == 400
    assert not EmailAddress.objects.get().verified


def test_expired_reset_key_is_rejected(client: Client) -> None:
    user = verified_user()
    post(client, "password/request", {"email": user.email})
    key = email_key("reset")
    with patch(
        "django.contrib.auth.tokens.PasswordResetTokenGenerator._now",
        return_value=datetime.now() + timedelta(minutes=31),
    ):
        assert (
            post(
                client,
                "password/reset",
                {"key": key, "password": "new-copper-moon-92!"},
            ).status_code
            == 400
        )


def test_csrf_and_origin_checks_cover_login_and_logout() -> None:
    user = verified_user()
    client = Client(enforce_csrf_checks=True)
    assert (
        post(client, "login", {"email": user.email, "password": PASSWORD}).status_code
        == 403
    )
    token = client.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    assert (
        client.post(
            BASE + "login",
            {"email": user.email, "password": PASSWORD},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN="https://evil.invalid",
        ).status_code
        == 403
    )
    assert (
        client.post(
            BASE + "login",
            {"email": user.email, "password": PASSWORD},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN="https://testserver",
        ).status_code
        == 200
    )
    assert client.delete(BASE + "session", secure=True).status_code == 403


def test_login_rate_limit_is_shared_between_sessions() -> None:
    verified_user()
    with override_settings(ACCOUNT_RATE_LIMITS={"login": "2/m/ip"}):
        responses = [
            post(
                Client(), "login", {"email": "river@example.test", "password": "wrong"}
            )
            for _ in range(3)
        ]
    assert [r.status_code for r in responses] == [400, 400, 429]


def test_app_token_client_and_runner_origin_are_not_trusted(client: Client) -> None:
    assert (
        client.post(
            "/api/v1/auth/app/v1/auth/login", {}, content_type="application/json"
        ).status_code
        == 404
    )
    client = Client(enforce_csrf_checks=True)
    token = client.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    assert (
        client.post(
            BASE + "signup",
            {},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN="https://localhost:8443",
        ).status_code
        == 403
    )


def test_expired_session_and_revoked_verification_are_denied(client: Client) -> None:
    from django.contrib.sessions.models import Session
    from django.utils import timezone

    user = verified_user()
    assert (
        post(client, "login", {"email": user.email, "password": PASSWORD}).status_code
        == 200
    )
    EmailAddress.objects.filter(user=user).update(verified=False)
    assert client.get("/api/v1/me/", secure=True).status_code == 403
    EmailAddress.objects.filter(user=user).update(verified=True)
    Session.objects.filter(session_key=client.session.session_key).update(
        expire_date=timezone.now() - timedelta(seconds=1)
    )
    assert client.get("/api/v1/me/", secure=True).status_code == 403


def test_account_responses_cannot_be_stored_by_shared_caches(client: Client) -> None:
    response = client.get(BASE + "session", secure=True)
    assert response["Cache-Control"] == "no-store"
    assert "Cookie" in response["Vary"]

from typing import Any

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.core.management.base import CommandError
from django.test import override_settings
from rest_framework.test import APIRequestFactory

from code_along.collaboration.api import ConsumeBody, PrivateAdmissionView, TicketBody
from code_along.collaboration.config import collaboration_settings
from code_along.collaboration.management.commands.provision_collaboration_role import (
    provision_role,
)


@pytest.mark.parametrize(
    "field,value",
    [
        ("generation", True),
        ("generation", "1"),
        ("scope", "owner"),
        ("client_session_id", "10000000-0000-0000-0000-000000000001"),
        ("awareness_client_id", -1),
        ("awareness_client_id", 4294967296),
        ("extra", "ignored"),
    ],
)
def test_ticket_contract_rejects_coercion_and_extra_fields(
    field: str, value: Any
) -> None:
    body = {
        "generation": 1,
        "scope": "write",
        "client_session_id": "10000000-0000-4000-8000-000000000001",
        "awareness_client_id": 7,
    }
    body[field] = value
    assert not TicketBody(data=body).is_valid()


def test_private_parser_rejects_unknown_credentials_and_versions() -> None:
    body = {
        "version": True,
        "ticket": "a" * 43,
        "document_name": "10000000-0000-4000-8000-000000000001:1",
        "connection_id": "10000000-0000-4000-8000-000000000002",
        "transport_id": "10000000-0000-4000-8000-000000000003",
        "origin": "https://testserver",
    }
    assert not ConsumeBody(data=body).is_valid()
    body["version"] = 1
    assert ConsumeBody(data=body).is_valid()
    body["session_key"] = "browser supplied"
    assert not ConsumeBody(data=body).is_valid()


@pytest.mark.parametrize(
    "environ",
    [
        {"CODE_ALONG_COLLABORATION_SECRET": "short"},
        {
            "CODE_ALONG_COLLABORATION_SECRET": "a" * 32,
            "CODE_ALONG_COLLABORATION_CONTROL_SECRET": "a" * 32,
        },
        {
            "CODE_ALONG_COLLABORATION_CONTROL_URL": "http://user:password@collaboration:1234"
        },
        {"CODE_ALONG_COLLABORATION_CONTROL_URL": "http://collaboration:1234/path"},
        {
            "CODE_ALONG_COLLABORATION_CONTROL_URL": "http://collaboration:1234?credential=x"
        },
    ],
)
def test_private_configuration_rejects_ambiguous_secrets_and_urls(
    environ: dict[str, str],
) -> None:
    with pytest.raises(ImproperlyConfigured):
        collaboration_settings(environ)


@pytest.mark.parametrize("suffix", ["SECRET", "CONTROL_SECRET"])
@pytest.mark.parametrize(
    "value", ["ÿ" * 32, "a" * 32 + "\x07", "a" * 32 + "\x7f", "a" * 32 + " ", "a" * 257]
)
def test_service_secrets_require_printable_ascii_without_whitespace(
    suffix: str, value: str
) -> None:
    with pytest.raises(ImproperlyConfigured):
        collaboration_settings({f"CODE_ALONG_COLLABORATION_{suffix}": value})


@pytest.mark.parametrize("authorization", ["Bearer ÿ", "Bearer \ud800", "Bearer \x07"])
def test_malformed_private_authorization_is_a_bounded_denial_without_database(
    authorization: str,
) -> None:
    request = APIRequestFactory().post(
        "/internal/v1/collaboration/consume/",
        {},
        format="json",
        HTTP_AUTHORIZATION=authorization,
    )
    with override_settings(COLLABORATION_SECRET="s" * 43):
        response = PrivateAdmissionView.as_view()(request)
    assert response.status_code == 403
    assert response.data == {"version": 1, "error": "unauthorized"}


@pytest.mark.parametrize(
    "user,password",
    [
        ("postgres", "x" * 43),
        ("public", "x" * 43),
        ("pg_dedicated", "x" * 43),
        ("bad; role", "x" * 43),
        ("dedicated", "short"),
    ],
)
def test_role_configuration_is_rejected_before_database_access(
    user: str, password: str
) -> None:
    with pytest.raises(CommandError):
        provision_role(user, password)

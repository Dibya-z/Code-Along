import secrets
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import close_old_connections
from django.test import Client, override_settings
from django.utils import timezone

from code_along.accounts.adapter import AccountAdapter
from code_along.collaboration import services
from code_along.collaboration.models import CollaborationLease, CollaborationTicket
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.projects import services as projects
from code_along.projects.models import Project
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]
SECRET = "node-to-api-" + "a" * 43
CONTROL = "api-to-node-" + "b" * 43
ORIGIN = "https://testserver"


@pytest.fixture(autouse=True)
def configuration() -> Iterator[None]:
    cache.clear()
    ensure_runtime_catalog()
    with override_settings(
        COLLABORATION_SECRET=SECRET, COLLABORATION_CONTROL_SECRET=CONTROL
    ):
        yield


def project_client() -> tuple[Project, Client]:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    return projects.create_project(owner, workspace.id, "Project"), signed_in(owner)


def issue(client: Client, project: Project, **changes: Any) -> dict[str, Any]:
    document = project.documents.get()
    body = {
        "generation": document.generation,
        "scope": "write",
        "client_session_id": str(uuid.uuid4()),
        "awareness_client_id": 7,
    }
    body.update(changes)
    response = client.post(
        f"/api/v1/projects/{project.id}/documents/{document.id}/ticket/",
        body,
        content_type="application/json",
        HTTP_ORIGIN=ORIGIN,
        secure=True,
    )
    assert response.status_code == 201, response.content
    assert "no-store" in response["Cache-Control"]
    return dict(response.json())


def consume_body(ticket: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "ticket": ticket["ticket"],
        "document_name": ticket["document_name"],
        "connection_id": str(uuid.uuid4()),
        "transport_id": str(uuid.uuid4()),
        "origin": ORIGIN,
    }


def private_post(
    client: Client, action: str, body: dict[str, Any], secret: str = SECRET
) -> Any:
    return client.post(
        f"/internal/v1/collaboration/{action}/",
        body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {secret}",
        secure=True,
    )


def admitted(
    client: Client, project: Project, **changes: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    body = consume_body(issue(client, project, **changes))
    response = private_post(client, "consume", body)
    assert response.status_code == 200, response.content
    return dict(response.json()), body


def renewal(grant: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "lease_id": grant["lease_id"],
        "lease_token": grant["lease_token"],
        "connection_id": body["connection_id"],
        "document_name": body["document_name"],
    }


def test_one_use_session_bound_admission_returns_only_approved_identity_and_starter() -> (
    None
):
    project, client = project_client()
    ticket = issue(client, project)
    row = CollaborationTicket.objects.get()
    assert row.token_digest == services.digest(ticket["ticket"])
    assert ticket["ticket"] != row.token_digest
    request = consume_body(ticket)
    response = private_post(client, "consume", request)
    assert response.status_code == 200
    grant = response.json()
    assert set(grant) == {
        "version",
        "lease_id",
        "lease_token",
        "ttl_ms",
        "scope",
        "client_session_id",
        "awareness_client_id",
        "workspace_id",
        "project_id",
        "workspace_acl_version",
        "project_acl_version",
        "user",
        "document",
    }
    assert set(grant["user"]) == {"id", "display_name", "color"}
    assert grant["user"]["id"] == str(project.owner_id)
    assert grant["scope"] == "write" and 0 < grant["ttl_ms"] <= 30000
    assert grant["document"]["initial_source"] == project.files.get().initial_source
    assert "session_key" not in str(grant) and "@example.test" not in str(grant)
    assert private_post(client, "consume", request).status_code == 403
    renewed = private_post(Client(), "renew", renewal(grant, request))
    assert (
        renewed.status_code == 200
    )  # No browser Cookie is needed/accepted as authority on renewal.
    assert renewed.json()["lease_id"] == grant["lease_id"]
    assert CollaborationLease.objects.count() == 1


@pytest.mark.parametrize(
    "failure",
    ["service", "session", "other_user", "origin", "document", "expired", "access"],
)
def test_consumption_rechecks_session_origin_document_expiry_and_current_access(
    failure: str,
) -> None:
    project, client = project_client()
    ticket = issue(client, project)
    body = consume_body(ticket)
    target = client
    secret = SECRET
    if failure == "service":
        secret = CONTROL
    elif failure == "session":
        target = Client()
    elif failure == "other_user":
        target = signed_in(person("other"))
    elif failure == "origin":
        body["origin"] = "https://localhost"
    elif failure == "document":
        body["document_name"] = f"{uuid.uuid4()}:1"
    elif failure == "expired":
        CollaborationTicket.objects.update(
            expires_at=timezone.now() - timedelta(seconds=1),
            created_at=timezone.now() - timedelta(minutes=1),
        )
    else:
        WorkspaceMembership.objects.filter(workspace=project.workspace).update(
            active=False
        )
    response = private_post(target, "consume", body, secret)
    assert response.status_code == 403
    assert response.json() == {"version": 1, "error": "unauthorized"}
    assert CollaborationLease.objects.count() == 0
    assert CollaborationTicket.objects.get().consumed_at is None


def test_tickets_are_per_document_even_on_the_same_transport() -> None:
    project, client = project_client()
    first = issue(client, project)
    other = projects.add_file(project.owner, project.id, 1, "other.py", "")
    second_response = client.post(
        f"/api/v1/projects/{project.id}/documents/{other.document.id}/ticket/",
        {
            "generation": 1,
            "scope": "write",
            "client_session_id": str(uuid.uuid4()),
            "awareness_client_id": 8,
        },
        content_type="application/json",
        HTTP_ORIGIN=ORIGIN,
        secure=True,
    )
    transport = str(uuid.uuid4())
    for ticket in (first, second_response.json()):
        body = consume_body(ticket)
        body["transport_id"] = transport
        assert private_post(client, "consume", body).status_code == 200
    assert CollaborationLease.objects.filter(transport_id=transport).count() == 2


def test_read_only_and_archived_scope_cannot_obtain_write_authority() -> None:
    project, client = project_client()
    member = person("viewer")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    projects.set_grant(project.owner, project.id, member.id, "viewer")
    viewer = signed_in(member)
    grant, _ = admitted(viewer, project, scope="read")
    assert grant["scope"] == "read"
    document = project.documents.get()
    url = f"/api/v1/projects/{project.id}/documents/{document.id}/ticket/"
    body = {
        "generation": 1,
        "scope": "write",
        "client_session_id": str(uuid.uuid4()),
        "awareness_client_id": 1,
    }
    assert (
        viewer.post(
            url, body, content_type="application/json", HTTP_ORIGIN=ORIGIN, secure=True
        ).status_code
        == 403
    )
    projects.update_project(project.owner, project.id, 1, archived=True)
    assert (
        client.post(
            url, body, content_type="application/json", HTTP_ORIGIN=ORIGIN, secure=True
        ).status_code
        == 403
    )
    assert admitted(client, project, scope="read")[0]["scope"] == "read"


@pytest.mark.parametrize(
    "failure",
    [
        "expired",
        "password",
        "disabled",
        "verification",
        "deleted_session",
        "wrong_connection",
        "wrong_token",
        "wrong_document",
        "revoked",
    ],
)
def test_lease_renewal_rechecks_real_framework_session_and_current_authority(
    failure: str,
) -> None:
    from allauth.account.models import EmailAddress

    project, client = project_client()
    grant, body = admitted(client, project)
    request = renewal(grant, body)
    if failure == "expired":
        CollaborationLease.objects.update(
            expires_at=timezone.now() - timedelta(seconds=1),
            created_at=timezone.now() - timedelta(minutes=1),
        )
    elif failure == "password":
        owner = project.owner
        owner.set_password("new-password-river-orbit-853!")
        owner.save(update_fields=["password"])
    elif failure == "disabled":
        type(project.owner).objects.filter(id=project.owner_id).update(is_active=False)
    elif failure == "verification":
        EmailAddress.objects.update(verified=False)
    elif failure == "deleted_session":
        Session.objects.filter(session_key=client.session.session_key).delete()
    elif failure == "wrong_connection":
        request["connection_id"] = str(uuid.uuid4())
    elif failure == "wrong_token":
        request["lease_token"] = secrets.token_urlsafe(32)
    elif failure == "wrong_document":
        request["document_name"] = f"{uuid.uuid4()}:1"
    else:
        services.revoke_leases(project_id=project.id)
    response = private_post(Client(), "renew", request)
    assert response.status_code == 403
    assert response.json()["error"] == (
        "lease_expired" if failure == "expired" else "unauthorized"
    )


@pytest.mark.parametrize(
    "mutation",
    [
        "grant",
        "member",
        "project_archive",
        "workspace_archive",
        "file_delete",
        "logout",
    ],
)
def test_authoritative_mutations_revoke_matching_live_leases(mutation: str) -> None:
    from django.test import RequestFactory

    project, owner_client = project_client()
    member = person("member")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    projects.set_grant(project.owner, project.id, member.id, "editor")
    member_client = signed_in(member)
    grant, body = admitted(member_client, project)
    if mutation == "grant":
        projects.revoke_grant(project.owner, project.id, member.id)
    elif mutation == "member":
        workspaces.update_member(
            project.owner, project.workspace_id, member.id, remove=True
        )
    elif mutation == "project_archive":
        projects.update_project(project.owner, project.id, 1, archived=True)
    elif mutation == "workspace_archive":
        workspaces.update_workspace(project.owner, project.workspace_id, archived=True)
    elif mutation == "file_delete":
        file = projects.add_file(project.owner, project.id, 1, "entry.py")
        projects.update_project(
            project.owner, project.id, 2, entrypoint_file_id=file.id
        )
        projects.delete_file(project.owner, project.id, project.entrypoint_file_id, 3)
    else:
        request = RequestFactory().get("/")
        request.session = member_client.session
        request.user = member
        AccountAdapter().logout(request)
    assert private_post(owner_client, "renew", renewal(grant, body)).status_code == 403
    assert not CollaborationLease.objects.filter(
        id=grant["lease_id"], revoked_at__isnull=True
    ).exists()


def test_expired_session_and_generation_cannot_be_renewed_even_without_invalidation() -> (
    None
):
    project, client = project_client()
    grant, body = admitted(client, project)
    Session.objects.filter(session_key=client.session.session_key).update(
        expire_date=timezone.now() - timedelta(seconds=1)
    )
    assert private_post(Client(), "renew", renewal(grant, body)).status_code == 403
    assert CollaborationLease.objects.get().expires_at <= timezone.now() + timedelta(
        seconds=30
    )


def test_public_ticket_requires_real_csrf_origin_and_verified_account() -> None:
    project, client = project_client()
    csrf = Client(enforce_csrf_checks=True)
    csrf.cookies[settings.SESSION_COOKIE_NAME] = client.cookies[
        settings.SESSION_COOKIE_NAME
    ].value
    document = project.documents.get()
    url = f"/api/v1/projects/{project.id}/documents/{document.id}/ticket/"
    body = {
        "generation": 1,
        "scope": "write",
        "client_session_id": str(uuid.uuid4()),
        "awareness_client_id": 7,
    }
    assert (
        csrf.post(
            url, body, content_type="application/json", HTTP_ORIGIN=ORIGIN, secure=True
        ).status_code
        == 403
    )
    token = csrf.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    assert (
        csrf.post(
            url,
            body,
            content_type="application/json",
            HTTP_ORIGIN=ORIGIN,
            HTTP_X_CSRFTOKEN=token,
            secure=True,
        ).status_code
        == 201
    )
    assert (
        csrf.post(
            url,
            body,
            content_type="application/json",
            HTTP_ORIGIN="https://localhost",
            HTTP_X_CSRFTOKEN=token,
            secure=True,
        ).status_code
        == 403
    )


@pytest.mark.django_db(transaction=True)
def test_competing_consumers_produce_exactly_one_lease() -> None:
    project, client = project_client()
    body = consume_body(issue(client, project))
    session_key = client.session.session_key
    assert session_key is not None

    def consume(_: int) -> str:
        close_old_connections()
        try:
            services.consume_ticket(
                session_key, **{k: v for k, v in body.items() if k != "version"}
            )
            return "accepted"
        except services.AdmissionError as error:
            return error.code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(consume, range(2))) == ["accepted", "unauthorized"]
    assert CollaborationLease.objects.count() == 1


def test_invalidation_is_post_commit_and_failure_does_not_change_revocation() -> None:
    project, client = project_client()
    grant, _ = admitted(client, project)
    with patch.object(services, "send_invalidation") as send:
        services.revoke_leases(project_id=project.id)
        assert not send.called  # pytest's outer transaction has not committed.
    assert CollaborationLease.objects.get(id=grant["lease_id"]).revoked_at is not None

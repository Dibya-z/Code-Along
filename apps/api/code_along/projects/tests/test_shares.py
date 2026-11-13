import uuid
from datetime import timedelta
from typing import Any

import pytest
from code_along.collaboration.models import CollaborationLease, CollaborationTicket
from code_along.projects import revision_dto, services
from code_along.projects.models import Project, ProjectAccess, ShareGrant
from code_along.projects.tests.test_history import create_revision, fixture_project
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.conf import settings
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.test import Client, override_settings
from django.utils import timezone

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]
SECRET = "shared-source-private-" + "s" * 43


@pytest.fixture(autouse=True)
def configuration() -> Any:
    cache.clear()
    with override_settings(COLLABORATION_SECRET=SECRET):
        yield


def share_link(
    project: Project,
    owner: Client,
    *,
    kind: str = "live",
    scope: str = "write",
    revision_id: uuid.UUID | None = None,
    recipient_id: uuid.UUID | None = None,
) -> tuple[ShareGrant, str]:
    response = owner.post(
        f"/api/v1/projects/{project.id}/shares/",
        {
            "kind": kind,
            "scope": scope,
            "revision_id": str(revision_id) if revision_id else None,
            "recipient_id": str(recipient_id) if recipient_id else None,
            "expires_hours": 1,
        },
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    body = response.json()
    dto = revision_dto.ShareCreated(data=body)
    assert dto.is_valid(), dto.errors
    assert "/shares#" in body["share_url"]
    return ShareGrant.objects.get(id=body["share"]["id"]), str(body["share_url"]).split(
        "#", 1
    )[1]


def resolve(client: Client, token: str) -> Any:
    return client.post(
        "/api/v1/shares/resolve/",
        {"token": token},
        content_type="application/json",
        HTTP_ORIGIN=settings.PUBLIC_APP_ORIGIN,
        secure=True,
    )


def ticket(
    client: Client, project: Project, token: str | None, scope: str = "write"
) -> Any:
    document = project.documents.get()
    body = {
        "generation": 1,
        "scope": scope,
        "client_session_id": str(uuid.uuid4()),
        "awareness_client_id": 7,
    }
    if token is not None:
        body["share_token"] = token
    return client.post(
        f"/api/v1/projects/{project.id}/documents/{document.id}/ticket/",
        body,
        content_type="application/json",
        HTTP_ORIGIN=settings.PUBLIC_APP_ORIGIN,
        secure=True,
    )


def consume(client: Client, ticket: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    body = {
        "version": 1,
        "ticket": ticket["ticket"],
        "document_name": ticket["document_name"],
        "connection_id": str(uuid.uuid4()),
        "transport_id": str(uuid.uuid4()),
        "origin": settings.PUBLIC_APP_ORIGIN,
    }
    response = client.post(
        "/internal/v1/collaboration/consume/",
        body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {SECRET}",
        secure=True,
    )
    return response, body


def renew(grant: dict[str, Any], original: dict[str, Any]) -> Any:
    return Client().post(
        "/internal/v1/collaboration/renew/",
        {
            "version": 1,
            "lease_id": grant["lease_id"],
            "lease_token": grant["lease_token"],
            "connection_id": original["connection_id"],
            "document_name": original["document_name"],
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Bearer {SECRET}",
        secure=True,
    )


def test_live_link_is_source_only_and_never_creates_an_ordinary_project_grant() -> None:
    project, owner = fixture_project()
    member = person("share-member")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    client = signed_in(member)
    share, token = share_link(project, owner)
    assert token != share.token_digest and len(token) == 43
    response = resolve(client, token)
    assert response.status_code == 200
    body = response.json()
    dto = revision_dto.LiveShareResolved(data=body)
    assert dto.is_valid(), dto.errors
    assert body["project"]["access"] == {"kind": "live_share", "scope": "write"}
    assert "role" not in body["project"] and "owner_id" not in body["project"]
    assert (
        body["files"]["items"][0]["initial_source"]
        == project.files.get().initial_source
    )
    assert token not in response.content.decode()
    assert not ProjectAccess.objects.filter(project=project, user=member).exists()
    for url in (
        f"/api/v1/projects/{project.id}/",
        f"/api/v1/projects/{project.id}/revisions/",
        f"/api/v1/projects/{project.id}/shares/",
        f"/api/v1/projects/{project.id}/files/",
    ):
        assert (
            client.get(url, HTTP_X_CODE_ALONG_SHARE=token, secure=True).status_code
            == 404
        )
    assert client.patch(
        f"/api/v1/projects/{project.id}/",
        {"name": "Forbidden", "expected_version": 1},
        content_type="application/json",
        HTTP_X_CODE_ALONG_SHARE=token,
        secure=True,
    ).status_code in {403, 404}
    admitted = ticket(client, project, token)
    assert admitted.status_code == 201
    accepted, request = consume(client, admitted.json())
    assert accepted.status_code == 200
    assert accepted.json()["scope"] == "write"
    assert renew(accepted.json(), request).status_code == 200
    assert CollaborationLease.objects.get().share_grant_id == share.id


def test_chosen_read_link_limits_even_an_owner_and_revocation_blocks_old_admission() -> (
    None
):
    project, owner = fixture_project()
    share, token = share_link(project, owner, scope="read")
    assert ticket(owner, project, token, "write").status_code == 403
    assert ticket(owner, project, None, "write").status_code == 201
    admitted = ticket(owner, project, token, "read")
    assert admitted.status_code == 201
    assert (
        owner.delete(
            f"/api/v1/projects/{project.id}/shares/{share.id}/", secure=True
        ).status_code
        == 204
    )
    assert consume(owner, admitted.json())[0].status_code == 403
    assert ticket(owner, project, token, "read").status_code == 403


def test_share_expiry_bounds_ticket_and_lease_and_revocation_invalidates_live_renewal() -> (
    None
):
    project, owner = fixture_project()
    share, token = share_link(project, owner)
    expiry = timezone.now() + timedelta(seconds=7)
    ShareGrant.objects.filter(id=share.id).update(expires_at=expiry)
    Session.objects.filter(session_key=owner.session.session_key).update(
        expire_date=timezone.now() + timedelta(seconds=15)
    )
    admitted = ticket(owner, project, token)
    assert admitted.status_code == 201
    stored_ticket = CollaborationTicket.objects.get()
    assert stored_ticket.expires_at == expiry
    response, original = consume(owner, admitted.json())
    assert response.status_code == 200
    assert CollaborationLease.objects.get().expires_at == expiry
    assert response.json()["ttl_ms"] <= 7000
    assert (
        owner.delete(
            f"/api/v1/projects/{project.id}/shares/{share.id}/", secure=True
        ).status_code
        == 204
    )
    assert CollaborationLease.objects.get().revoked_at is not None
    assert renew(response.json(), original).status_code == 403


@pytest.mark.parametrize("fault", ["expired", "revoked", "recipient", "membership"])
def test_live_capability_is_rechecked_when_consumed_and_renewed(fault: str) -> None:
    project, owner = fixture_project()
    member = person("member")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    client = signed_in(member)
    share, token = share_link(project, owner)
    admitted = ticket(client, project, token)
    response, original = consume(client, admitted.json())
    assert response.status_code == 200
    another = ticket(client, project, token)
    if fault == "expired":
        ShareGrant.objects.filter(id=share.id).update(
            expires_at=timezone.now() - timedelta(seconds=1),
            created_at=timezone.now() - timedelta(hours=1),
        )
    elif fault == "revoked":
        ShareGrant.objects.filter(id=share.id).update(revoked_at=timezone.now())
    elif fault == "recipient":
        ShareGrant.objects.filter(id=share.id).update(recipient=project.owner)
    else:
        WorkspaceMembership.objects.filter(
            workspace=project.workspace, user=member
        ).update(active=False)
    assert consume(client, another.json())[0].status_code == 403
    assert renew(response.json(), original).status_code == 403
    assert resolve(client, token).status_code in {403, 404}


def test_snapshot_link_exposes_only_frozen_revision_and_recipient_and_revoke_are_enforced() -> (
    None
):
    project, owner = fixture_project()
    revision = create_revision(project, owner)
    share, token = share_link(
        project, owner, kind="snapshot", scope="read", revision_id=revision.id
    )
    response = resolve(Client(), token)
    assert response.status_code == 200
    dto = revision_dto.SnapshotShareResolved(data=response.json())
    assert dto.is_valid(), dto.errors
    assert set(response.json()) == {"kind", "share_id", "expires_at", "revision"}
    assert set(response.json()["revision"]) == {"id", "name", "created_at", "manifest"}
    assert response.json()["revision"]["manifest"]["files"][0]["source"].startswith(
        "# frozen live"
    )
    assert "no-store" in response["Cache-Control"]
    member = person("snapshot-recipient")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    bound, bound_token = share_link(
        project,
        owner,
        kind="snapshot",
        scope="read",
        revision_id=revision.id,
        recipient_id=member.id,
    )
    assert resolve(Client(), bound_token).status_code == 403
    assert resolve(owner, bound_token).status_code == 403
    assert resolve(signed_in(member), bound_token).status_code == 200
    assert ticket(owner, project, token, "read").status_code == 403
    owner.delete(f"/api/v1/projects/{project.id}/shares/{share.id}/", secure=True)
    assert resolve(Client(), token).status_code == 403
    ShareGrant.objects.filter(id=bound.id).update(
        expires_at=timezone.now() - timedelta(seconds=1),
        created_at=timezone.now() - timedelta(hours=1),
    )
    assert resolve(signed_in(member), bound_token).status_code == 403


def test_share_management_is_owner_only_and_cross_project_parent_bindings_are_enforced() -> (
    None
):
    project, owner = fixture_project()
    other = services.create_project(
        project.owner, project.workspace_id, "Other project"
    )
    other_revision = create_revision(other, owner)
    with pytest.raises(IntegrityError), transaction.atomic():
        ShareGrant.objects.create(
            project=project,
            revision=other_revision,
            created_by=project.owner,
            kind="snapshot",
            scope="read",
            token_digest="0" * 64,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    member = person("source-editor")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=member, role="learner"
    )
    services.set_grant(project.owner, project.id, member.id, "editor")
    assert (
        signed_in(member)
        .get(f"/api/v1/projects/{project.id}/shares/", secure=True)
        .status_code
        == 403
    )
    assert (
        signed_in(member)
        .post(
            f"/api/v1/projects/{project.id}/shares/",
            {
                "kind": "live",
                "scope": "write",
                "revision_id": None,
                "recipient_id": None,
                "expires_hours": 1,
            },
            content_type="application/json",
            secure=True,
        )
        .status_code
        == 403
    )
    share, token = share_link(other, owner)
    ticket(owner, project, None)
    with pytest.raises(IntegrityError), transaction.atomic():
        CollaborationTicket.objects.update(share_grant=share)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    assert (
        resolve(Client(), token).status_code == 403
    )  # Live links always require a verified session.

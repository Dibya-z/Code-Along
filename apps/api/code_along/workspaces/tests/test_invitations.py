import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest
from code_along.workspaces import invitations, services
from code_along.workspaces.models import (
    WorkspaceInvitation,
)
from code_along.workspaces.models import (
    WorkspaceMembership as Membership,
)
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.db import close_old_connections
from django.test import Client
from django.utils import timezone
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


def test_digest_only_recipient_bound_acceptance_and_retry() -> None:
    owner = person("owner")
    recipient = person("recipient")
    wrong = person("wrong")
    workspace = services.create_workspace(owner, "Group")
    invitation, token = invitations.create_invitation(
        owner, workspace.id, recipient.email.upper(), "learner", 72
    )
    assert token not in repr(invitation.__dict__)
    assert (
        len(invitation.token_digest) == 64
        and invitation.recipient_email == recipient.email
    )
    with pytest.raises(NotFound):
        invitations.accept_invitation(wrong, token)
    accepted = invitations.accept_invitation(recipient, token)
    assert accepted.id == workspace.id
    assert invitations.accept_invitation(recipient, token).id == workspace.id
    assert (
        Membership.objects.filter(
            workspace=workspace, user=recipient, active=True
        ).count()
        == 1
    )
    invitation.refresh_from_db()
    assert invitation.accepted_by == recipient


@pytest.mark.parametrize("state", ["expired", "revoked", "archived"])
def test_unavailable_invitation_does_not_create_membership(state: str) -> None:
    owner = person("owner")
    recipient = person("recipient")
    workspace = services.create_workspace(owner, "Group")
    invitation, token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )
    if state == "expired":
        WorkspaceInvitation.objects.filter(id=invitation.id).update(
            created_at=timezone.now() - timedelta(days=3),
            expires_at=timezone.now() - timedelta(days=1),
        )
    elif state == "revoked":
        invitations.revoke_invitation(owner, workspace.id, invitation.id)
    else:
        services.update_workspace(owner, workspace.id, archived=True)
    with pytest.raises(NotFound):
        invitations.accept_invitation(recipient, token)
    assert not Membership.objects.filter(workspace=workspace, user=recipient).exists()


def test_only_owner_can_issue_list_or_revoke_and_ids_are_parent_scoped() -> None:
    owner = person("owner")
    other = person("other")
    workspace = services.create_workspace(owner, "Group")
    foreign = services.create_workspace(other, "Foreign")
    Membership.objects.create(workspace=workspace, user=other, role="instructor")
    with pytest.raises(PermissionDenied):
        invitations.create_invitation(other, workspace.id, owner.email, "learner", 72)
    invitation, token = invitations.create_invitation(
        owner, workspace.id, other.email, "learner", 72
    )
    with pytest.raises(NotFound):
        invitations.revoke_invitation(other, foreign.id, invitation.id)
    response = signed_in(other).get(f"/api/v1/workspaces/{workspace.id}/invitations/")
    assert response.status_code == 403
    response = signed_in(owner).get(f"/api/v1/workspaces/{workspace.id}/invitations/")
    assert (
        response.status_code == 200
        and token not in response.content.decode()
        and invitation.token_digest not in response.content.decode()
    )


def test_existing_role_is_preserved_and_removal_cannot_be_undone_with_old_token() -> (
    None
):
    owner = person("owner")
    recipient = person("recipient")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=recipient, role="instructor")
    _, token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )
    invitations.accept_invitation(recipient, token)
    assert (
        Membership.objects.get(workspace=workspace, user=recipient).role == "instructor"
    )
    pending, pending_token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )
    services.update_member(owner, workspace.id, recipient.id, remove=True)
    with pytest.raises(NotFound):
        invitations.accept_invitation(recipient, token)
    with pytest.raises(NotFound):
        invitations.accept_invitation(recipient, pending_token)
    pending.refresh_from_db()
    assert pending.revoked_at is not None
    _, fresh = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )
    invitations.accept_invitation(recipient, fresh)
    assert Membership.objects.get(workspace=workspace, user=recipient).role == "learner"


def test_ownership_transfer_revokes_pending_links() -> None:
    owner = person("owner")
    recipient = person("recipient")
    target = person("target")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=target, role="learner")
    invitation, token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )
    services.transfer_ownership(owner, workspace.id, target.id)
    invitation.refresh_from_db()
    assert invitation.revoked_at is not None
    with pytest.raises(NotFound):
        invitations.accept_invitation(recipient, token)


@pytest.mark.django_db(transaction=True)
def test_concurrent_accepts_create_exactly_one_membership() -> None:
    owner = person("owner")
    recipient = person("recipient")
    workspace = services.create_workspace(owner, "Group")
    _, token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )

    def accept(_index: int) -> uuid.UUID:
        close_old_connections()
        try:
            return invitations.accept_invitation(recipient, token).id
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(accept, [1, 2]))
    assert result == [workspace.id, workspace.id]
    assert Membership.objects.filter(workspace=workspace, user=recipient).count() == 1


@pytest.mark.django_db(transaction=True)
def test_accept_and_revoke_race_is_serialized() -> None:
    owner = person("owner")
    recipient = person("recipient")
    workspace = services.create_workspace(owner, "Group")
    invitation, token = invitations.create_invitation(
        owner, workspace.id, recipient.email, "learner", 72
    )

    def action(kind: str) -> str:
        close_old_connections()
        try:
            if kind == "accept":
                try:
                    invitations.accept_invitation(recipient, token)
                    return "accepted"
                except NotFound:
                    return "denied"
            try:
                invitations.revoke_invitation(owner, workspace.id, invitation.id)
                return "revoked"
            except ValidationError:
                return "already accepted"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(action, ["accept", "revoke"]))
    assert result in [["accepted", "already accepted"], ["denied", "revoked"]]
    assert Membership.objects.filter(
        workspace=workspace, user=recipient, active=True
    ).exists() == (result[0] == "accepted")


def test_api_preview_and_accept_are_authenticated_and_validate_tokens() -> None:
    owner = person("owner")
    recipient = person("recipient")
    workspace = services.create_workspace(owner, "Group")
    client = signed_in(owner)
    response = client.post(
        f"/api/v1/workspaces/{workspace.id}/invitations/",
        {"recipient_email": recipient.email, "role": "learner", "expires_hours": 72},
        content_type="application/json",
    )
    assert response.status_code == 201
    token = response.json()["invite_url"].rsplit("/", 1)[1]
    assert (
        Client()
        .post(
            "/api/v1/invitations/accept/",
            {"token": token},
            content_type="application/json",
        )
        .status_code
        == 403
    )
    recipient_client = signed_in(recipient)
    assert (
        recipient_client.post(
            "/api/v1/invitations/preview/",
            {"token": token},
            content_type="application/json",
        ).json()["workspace_name"]
        == "Group"
    )
    assert recipient_client.post(
        "/api/v1/invitations/accept/", {"token": token}, content_type="application/json"
    ).json() == {"workspace_id": str(workspace.id)}
    assert (
        recipient_client.post(
            "/api/v1/invitations/accept/",
            {"token": "../bad"},
            content_type="application/json",
        ).status_code
        == 400
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"role": "owner"},
        {"expires_hours": 169},
        {"expires_hours": 0},
        {"recipient_email": "bad"},
        {"token_digest": "forged"},
    ],
)
def test_create_rejects_unsafe_scope_or_expiry(fields: dict[str, object]) -> None:
    owner = person("owner")
    workspace = services.create_workspace(owner, "Group")
    body = {"recipient_email": "recipient@example.test", **fields}
    assert (
        signed_in(owner)
        .post(
            f"/api/v1/workspaces/{workspace.id}/invitations/",
            body,
            content_type="application/json",
        )
        .status_code
        == 400
    )

import pytest
from code_along.projects import services, sharing
from code_along.projects.models import ProjectAccess
from code_along.workspaces import invitations
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import (
    WorkspaceInvitation,
)
from code_along.workspaces.models import (
    WorkspaceMembership as Membership,
)
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.db import IntegrityError, connection, transaction
from rest_framework.exceptions import NotFound, ValidationError

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


def test_project_invitation_requires_membership_and_grants_only_its_role() -> None:
    owner = person("owner")
    member = person("member")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Private")
    with pytest.raises(ValidationError):
        sharing.create_project_invitation(owner, project.id, member.email, "viewer", 72)
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    invitation, token = sharing.create_project_invitation(
        owner, project.id, member.email, "viewer", 72
    )
    response = signed_in(member).post(
        "/api/v1/invitations/accept/", {"token": token}, content_type="application/json"
    )
    assert response.status_code == 200 and response.json()["project_id"] == str(
        project.id
    )
    assert ProjectAccess.objects.get(project=project, user=member).role == "viewer"
    assert (
        signed_in(member)
        .post(
            f"/api/v1/projects/{project.id}/files/",
            {"path": "denied.py", "expected_version": 1},
            content_type="application/json",
        )
        .status_code
        == 403
    )
    assert invitation.project_id == project.id and token not in repr(
        invitation.__dict__
    )
    services.revoke_grant(owner, project.id, member.id)
    with pytest.raises(NotFound):
        invitations.accept_invitation(member, token)
    assert not ProjectAccess.objects.filter(project=project, user=member).exists()


def test_workspace_owner_cannot_see_or_revoke_private_project_invitations() -> None:
    manager = person("manager")
    owner = person("owner")
    member = person("member")
    workspace = workspaces.create_workspace(manager, "Group")
    for user in [owner, member]:
        Membership.objects.create(workspace=workspace, user=user, role="learner")
    project = services.create_project(owner, workspace.id, "Private")
    invitation, _ = sharing.create_project_invitation(
        owner, project.id, member.email, "editor", 72
    )
    client = signed_in(manager)
    assert (
        client.get(f"/api/v1/workspaces/{workspace.id}/invitations/").json()["count"]
        == 0
    )
    assert client.get(f"/api/v1/projects/{project.id}/invitations/").status_code == 404
    assert (
        client.delete(
            f"/api/v1/workspaces/{workspace.id}/invitations/{invitation.id}/"
        ).status_code
        == 404
    )


def test_parent_pair_and_scope_role_constraints_reject_forged_targets() -> None:
    owner = person("owner")
    member = person("member")
    workspace = workspaces.create_workspace(owner, "Group")
    other = workspaces.create_workspace(owner, "Other")
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    project = services.create_project(owner, workspace.id, "Private")
    invitation, _ = sharing.create_project_invitation(
        owner, project.id, member.email, "viewer", 72
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceInvitation.objects.filter(id=invitation.id).update(workspace=other)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    with pytest.raises(IntegrityError), transaction.atomic():
        WorkspaceInvitation.objects.filter(id=invitation.id).update(role="instructor")


def test_role_change_and_owner_transfer_invalidate_pending_project_links() -> None:
    owner = person("owner")
    member = person("member")
    target = person("target")
    workspace = workspaces.create_workspace(owner, "Group")
    for user in [member, target]:
        Membership.objects.create(workspace=workspace, user=user, role="learner")
    project = services.create_project(owner, workspace.id, "Private")
    pending, token = sharing.create_project_invitation(
        owner, project.id, member.email, "editor", 72
    )
    services.set_grant(owner, project.id, member.id, "viewer")
    pending.refresh_from_db()
    assert pending.revoked_at is not None
    with pytest.raises(NotFound):
        invitations.accept_invitation(member, token)
    second, token = sharing.create_project_invitation(
        owner, project.id, target.email, "viewer", 72
    )
    services.transfer_project(owner, project.id, target.id, 1)
    second.refresh_from_db()
    assert second.revoked_at is not None
    with pytest.raises(NotFound):
        invitations.accept_invitation(target, token)


def test_workspace_transfer_preserves_independent_project_invitations() -> None:
    owner = person("owner")
    target = person("target")
    recipient = person("recipient")
    workspace = workspaces.create_workspace(owner, "Group")
    for user in [target, recipient]:
        Membership.objects.create(workspace=workspace, user=user, role="learner")
    project = services.create_project(owner, workspace.id, "Private")
    _, token = sharing.create_project_invitation(
        owner, project.id, recipient.email, "viewer", 72
    )
    workspaces.transfer_ownership(owner, workspace.id, target.id)
    invitations.accept_invitation(recipient, token)
    assert ProjectAccess.objects.get(project=project, user=recipient).role == "viewer"

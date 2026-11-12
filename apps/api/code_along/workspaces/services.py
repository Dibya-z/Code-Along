import uuid

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from code_along.accounts.models import User

from .models import Workspace, WorkspaceInvitation, WorkspaceMembership
from .policies import require_membership


def lock_workspace(workspace_id: uuid.UUID) -> Workspace:
    try:
        return Workspace.objects.select_for_update().get(id=workspace_id)
    except Workspace.DoesNotExist:
        raise NotFound("Workspace unavailable.") from None


def require_open(workspace: Workspace) -> None:
    if workspace.archived_at is not None:
        raise ValidationError(
            {"detail": "Restore this workspace before making changes."}
        )


def bump_acl(workspace: Workspace) -> None:
    workspace.acl_version += 1
    workspace.save(update_fields=["acl_version", "updated_at"])


@transaction.atomic
def create_workspace(user: User, name: str) -> Workspace:
    workspace = Workspace.objects.create(name=name, created_by=user)
    WorkspaceMembership.objects.create(
        workspace=workspace, user=user, role=WorkspaceMembership.Role.OWNER
    )
    return workspace


@transaction.atomic
def update_workspace(
    user: User,
    workspace_id: uuid.UUID,
    *,
    name: str | None = None,
    archived: bool | None = None,
) -> Workspace:
    workspace = lock_workspace(workspace_id)
    require_membership(workspace, user, owner=True)
    if name is not None:
        workspace.name = name
    if archived is not None:
        workspace.archived_at = timezone.now() if archived else None
    workspace.acl_version += 1
    workspace.save(update_fields=["name", "archived_at", "acl_version", "updated_at"])
    return workspace


@transaction.atomic
def update_member(
    user: User,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    *,
    role: str | None = None,
    remove: bool = False,
) -> None:
    workspace = lock_workspace(workspace_id)
    caller = require_membership(workspace, user)
    require_open(workspace)
    if caller.role != WorkspaceMembership.Role.OWNER and not (
        remove and user.id == user_id
    ):
        require_membership(workspace, user, owner=True)
    try:
        member = WorkspaceMembership.objects.get(
            workspace=workspace, user_id=user_id, active=True
        )
    except WorkspaceMembership.DoesNotExist:
        raise NotFound("Member unavailable.") from None
    if member.role == WorkspaceMembership.Role.OWNER:
        raise ValidationError(
            {
                "detail": "Transfer workspace ownership before changing the owner membership."
            }
        )
    if remove:
        member.active = False
        WorkspaceInvitation.objects.filter(
            workspace=workspace,
            recipient_email=member.user.email,
            accepted_at__isnull=True,
            revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())
    elif role in {
        WorkspaceMembership.Role.INSTRUCTOR,
        WorkspaceMembership.Role.LEARNER,
    }:
        member.role = role
    else:
        raise ValidationError({"role": "Choose instructor or learner."})
    member.save(update_fields=["role", "active"])
    bump_acl(workspace)


@transaction.atomic
def transfer_ownership(
    user: User, workspace_id: uuid.UUID, new_owner_id: uuid.UUID
) -> Workspace:
    workspace = lock_workspace(workspace_id)
    old = require_membership(workspace, user, owner=True)
    require_open(workspace)
    try:
        target = WorkspaceMembership.objects.get(
            workspace=workspace, user_id=new_owner_id, active=True, user__is_active=True
        )
    except WorkspaceMembership.DoesNotExist:
        raise ValidationError(
            {"new_owner_id": "Choose an active workspace member."}
        ) from None
    if old.id == target.id:
        return workspace
    WorkspaceInvitation.objects.filter(
        workspace=workspace, accepted_at__isnull=True, revoked_at__isnull=True
    ).update(revoked_at=timezone.now())
    old.role = WorkspaceMembership.Role.INSTRUCTOR
    old.save(update_fields=["role"])
    target.role = WorkspaceMembership.Role.OWNER
    target.save(update_fields=["role"])
    bump_acl(workspace)
    return workspace

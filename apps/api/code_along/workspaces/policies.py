from django.db.models import QuerySet
from rest_framework.exceptions import NotFound, PermissionDenied

from code_along.accounts.models import User

from .models import Workspace, WorkspaceMembership


def visible_workspaces(user: User) -> QuerySet[Workspace]:
    return Workspace.objects.filter(memberships__user=user, memberships__active=True)


def require_membership(
    workspace: Workspace, user: User, *, owner: bool = False
) -> WorkspaceMembership:
    member = WorkspaceMembership.objects.filter(
        workspace=workspace, user=user, active=True
    ).first()
    if member is None:
        raise NotFound("Workspace unavailable.")
    if owner and member.role != WorkspaceMembership.Role.OWNER:
        raise PermissionDenied("Only the workspace owner can do that.")
    return member

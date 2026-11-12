from django.db.models import Q, QuerySet
from rest_framework.exceptions import NotFound, PermissionDenied

from code_along.accounts.models import User
from code_along.workspaces.policies import require_membership

from .models import Project


def visible_projects(user: User) -> QuerySet[Project]:
    return (
        Project.objects.filter(
            workspace__memberships__user=user, workspace__memberships__active=True
        )
        .filter(Q(owner=user) | Q(access_grants__user=user))
        .distinct()
    )


def project_role(
    project: Project, user: User, *, write: bool = False, owner: bool = False
) -> str:
    require_membership(project.workspace, user)
    if project.owner_id == user.id:
        role = "owner"
    else:
        grant = project.access_grants.filter(user=user).first()
        if grant is None:
            raise NotFound("Project unavailable.")
        role = grant.role
    if owner and role != "owner" or write and role == "viewer":
        raise PermissionDenied("Your project role does not allow this action.")
    return role

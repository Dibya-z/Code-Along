from rest_framework.exceptions import PermissionDenied, ValidationError

from code_along.accounts.models import User
from code_along.workspaces.models import Workspace, WorkspaceMembership
from code_along.workspaces.policies import require_membership
from code_along.workspaces.services import require_open

from .models import Assignment


def is_teacher(workspace: Workspace, actor: User) -> bool:
    return require_membership(workspace, actor).role in {"owner", "instructor"}


def require_assignment_teacher(
    workspace: Workspace, actor: User
) -> WorkspaceMembership:
    member = require_membership(workspace, actor)
    if member.role not in {"owner", "instructor"}:
        raise PermissionDenied(
            "Only current workspace teaching staff can author assignments."
        )
    return member


def require_assignment_mutable(assignment: Assignment) -> None:
    require_open(assignment.workspace)
    if assignment.archived_at is not None:
        raise ValidationError(
            {"detail": "Restore this assignment before changing its draft."}
        )

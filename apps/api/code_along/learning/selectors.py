import uuid

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from code_along.accounts.models import User
from code_along.workspaces.models import Workspace

from .models import Assignment, AssignmentVersion
from .policies import is_teacher


def visible_assignments(workspace: Workspace, actor: User) -> QuerySet[Assignment]:
    query = Assignment.objects.filter(workspace=workspace).select_related(
        "workspace", "current_version"
    )
    return (
        query
        if is_teacher(workspace, actor)
        else query.filter(current_version__isnull=False)
    )


def readable_assignment(assignment_id: uuid.UUID, actor: User) -> Assignment:
    candidate = get_object_or_404(
        Assignment.objects.select_related("workspace"), id=assignment_id
    )
    return get_object_or_404(
        visible_assignments(candidate.workspace, actor), id=assignment_id
    )


def read_assignment_version(
    assignment: Assignment, version_id: uuid.UUID
) -> AssignmentVersion:
    return get_object_or_404(
        AssignmentVersion.objects.select_related("starter_revision", "runtime_profile"),
        assignment=assignment,
        id=version_id,
    )

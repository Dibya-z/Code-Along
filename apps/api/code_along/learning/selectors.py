import uuid

from django.db.models import Q, QuerySet
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import NotFound

from code_along.accounts.models import User
from code_along.projects.revision_scopes import require_project_revision
from code_along.workspaces.models import Workspace

from .models import Assignment, AssignmentVersion
from .policies import is_teacher


def public_version_scope(prefix: str = "") -> Q:
    return Q(
        **{
            f"{prefix}starter_scope": "project",
            f"{prefix}starter_revision__artifact_scope": "project",
            f"{prefix}starter_revision__provenance": "shared_room_capture",
            f"{prefix}starter_revision__manifest_version": 1,
        }
    )


def public_versions() -> QuerySet[AssignmentVersion]:
    return AssignmentVersion.objects.filter(public_version_scope()).select_related(
        "starter_revision", "runtime_profile"
    )


def require_public_version(version: AssignmentVersion) -> None:
    if (
        version.starter_scope != "project"
        or version.starter_project_id != version.starter_revision.project_id
    ):
        raise NotFound("Published version unavailable.")
    require_project_revision(version.starter_revision)


def require_public_draft(assignment: Assignment) -> None:
    if assignment.draft_starter_scope != "project":
        raise NotFound("Assignment draft unavailable.")
    revision = assignment.draft_starter_revision
    if revision is None:
        if assignment.draft_starter_project_id is not None:
            raise NotFound("Assignment draft unavailable.")
    else:
        if revision.project_id != assignment.draft_starter_project_id:
            raise NotFound("Assignment draft unavailable.")
        require_project_revision(revision)


def visible_assignments(workspace: Workspace, actor: User) -> QuerySet[Assignment]:
    query = (
        Assignment.objects.filter(workspace=workspace)
        .filter(
            Q(current_version__isnull=True) | public_version_scope("current_version__")
        )
        .select_related("workspace", "current_version__starter_revision")
    )
    if is_teacher(workspace, actor):
        return (
            query.filter(draft_starter_scope="project")
            .filter(
                Q(
                    draft_starter_revision__isnull=True,
                    draft_starter_project__isnull=True,
                )
                | Q(
                    draft_starter_revision__artifact_scope="project",
                    draft_starter_revision__provenance="shared_room_capture",
                    draft_starter_revision__manifest_version=1,
                )
            )
            .select_related("draft_starter_revision")
        )
    return query.filter(current_version__isnull=False)


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
        public_versions(),
        assignment=assignment,
        id=version_id,
    )

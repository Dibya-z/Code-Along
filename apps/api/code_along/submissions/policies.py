from datetime import datetime

from django.db.models import Count

from code_along.accounts.models import User
from code_along.learning.models import AssignmentWork
from code_along.learning.participation_services import active_verified
from code_along.learning.work_services import subject_members
from code_along.projects.models import Project
from code_along.projects.policies import visible_projects
from code_along.projects.revision_contract import (
    HELPER_RELEASE,
    RevisionContractError,
    runtime_identity,
)

from .errors import SubmissionError
from .models import (
    SubmissionAssignmentUsage,
    SubmissionParticipant,
    SubmissionWorkspaceUsage,
)

ASSIGNMENT_SUBMISSION_LIMIT = 256
WORKSPACE_SUBMISSION_LIMIT = 1024
ASSIGNMENT_SOURCE_BYTES = 32 * 1024 * 1024
WORKSPACE_SOURCE_BYTES = 128 * 1024 * 1024
ASSIGNMENT_METADATA_BYTES = 4 * 1024 * 1024
WORKSPACE_METADATA_BYTES = 16 * 1024 * 1024


def new_submit_reason(
    work: AssignmentWork,
    actor: User,
    project: Project | None,
    now: datetime,
    *,
    source_bytes: int = 0,
    metadata_bytes: int = 0,
) -> str | None:
    """One shared policy for advisory availability and final locked admission."""
    if (
        work.state != "active"
        or work.assignment.archived_at
        or work.workspace.archived_at
    ):
        return "submission_work_unavailable"
    members = subject_members(work)
    users = {member.user_id for member in members}
    if actor.id not in users or not active_verified(work.workspace, actor.id):
        return "submission_participation_unavailable"
    if (
        project is None
        or not visible_projects(actor).filter(id=work.project_id).exists()
    ):
        return "submission_source_unavailable"
    if project.archived_at:
        return "submission_work_unavailable"
    if project.owner_id not in users:
        return "submission_roster_changed"
    version = work.assignment_version
    try:
        runtime_valid = (
            version.helper_release == HELPER_RELEASE
            and version.runtime_identity == runtime_identity(project.runtime_profile)
            and version.runtime_manifest == project.runtime_profile.manifest
        )
    except RevisionContractError:
        runtime_valid = False
    if not runtime_valid:
        return "submission_runtime_changed"
    if version.due_at is not None and now > version.due_at:
        return "submission_deadline_passed"
    attempts = (
        SubmissionParticipant.objects.filter(
            assignment_version=version, user_id__in=users
        )
        .values("user_id")
        .annotate(count=Count("id"))
    )
    if any(item["count"] >= version.max_attempts for item in attempts):
        return "submission_attempt_limit"
    assignment_usage = SubmissionAssignmentUsage.objects.filter(
        assignment=work.assignment
    ).first()
    workspace_usage = SubmissionWorkspaceUsage.objects.filter(
        workspace=work.workspace
    ).first()
    for usage, count, raw, meta, prefix in (
        (
            assignment_usage,
            ASSIGNMENT_SUBMISSION_LIMIT,
            ASSIGNMENT_SOURCE_BYTES,
            ASSIGNMENT_METADATA_BYTES,
            "assignment",
        ),
        (
            workspace_usage,
            WORKSPACE_SUBMISSION_LIMIT,
            WORKSPACE_SOURCE_BYTES,
            WORKSPACE_METADATA_BYTES,
            "workspace",
        ),
    ):
        if usage is not None:
            if usage.count >= count or usage.metadata_bytes + metadata_bytes > meta:
                return f"{prefix}_submission_capacity"
            # At equality a valid zero-byte candidate must remain possible.
            if usage.source_bytes + source_bytes > raw:
                return f"{prefix}_submission_storage_capacity"
    return None


def require_new_submit(
    work: AssignmentWork,
    actor: User,
    project: Project,
    now: datetime,
    *,
    source_bytes: int = 0,
    metadata_bytes: int = 0,
) -> None:
    reason = new_submit_reason(
        work,
        actor,
        project,
        now,
        source_bytes=source_bytes,
        metadata_bytes=metadata_bytes,
    )
    if reason:
        raise SubmissionError(
            reason, "This work cannot accept a new submission under its current policy."
        )

import copy
import uuid
from typing import Any

from django.db import transaction
from django.db.models import Count, Max
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import (
    APIException,
    NotFound,
    ValidationError,
)

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.projects.models import Project, ProjectRevision, RuntimeProfile
from code_along.projects.policies import project_role
from code_along.projects.revision_contract import (
    HELPER_RELEASE,
    RevisionContractError,
    runtime_identity,
)
from code_along.projects.revision_services import (
    RevisionUnavailable,
    current_actor,
    revision_manifest,
)
from code_along.workspaces.services import lock_workspace, require_open

from . import contracts
from .models import Assignment, AssignmentVersion
from .policies import require_assignment_mutable, require_assignment_teacher


class AssignmentConflict(APIException):
    status_code = 409
    default_detail = "This assignment changed. Reload it before trying again."


class AssignmentCapacity(APIException):
    status_code = 409

    def __init__(self, code: str, detail: str) -> None:
        super().__init__({"code": code, "detail": detail})


def lock_assignment(assignment_id: uuid.UUID) -> Assignment:
    workspace_id = get_object_or_404(
        Assignment.objects.only("workspace_id"), id=assignment_id
    ).workspace_id
    workspace = lock_workspace(workspace_id)
    assignment = get_object_or_404(
        Assignment.objects.select_for_update(), id=assignment_id, workspace=workspace
    )
    assignment.workspace = workspace
    return assignment


def check_revision(assignment: Assignment, expected: int) -> None:
    if assignment.revision != expected or assignment.revision >= 9007199254740991:
        raise AssignmentConflict()


def prior_starter(
    assignment: Assignment, revision_id: uuid.UUID
) -> AssignmentVersion | None:
    return (
        AssignmentVersion.objects.filter(
            assignment=assignment, starter_revision_id=revision_id
        )
        .order_by("number")
        .first()
    )


def authorize_starter_selection(
    assignment: Assignment, revision_id: uuid.UUID, user: User
) -> ProjectRevision:
    """Check published authority before querying any private live project."""
    require_assignment_teacher(assignment.workspace, user)
    published = prior_starter(assignment, revision_id)
    if published is not None:
        revision = get_object_or_404(
            ProjectRevision.objects.select_related("runtime_profile"),
            id=revision_id,
            project_id=published.starter_project_id,
        )
        if (
            published.workspace_id != assignment.workspace_id
            or published.starter_manifest_sha256 != revision.manifest_sha256
            or published.runtime_profile_id != revision.runtime_profile_id
            or published.runtime_identity != revision.runtime_identity
            or published.runtime_manifest != revision.runtime_manifest
            or published.helper_release != revision.helper_release
        ):
            raise RevisionUnavailable()
    else:
        # First disclosure must be a currently owned same-workspace project.
        revision = get_object_or_404(
            ProjectRevision.objects.select_related("runtime_profile"), id=revision_id
        )
        source = get_object_or_404(
            Project.objects.select_for_update(),
            id=revision.project_id,
            workspace_id=assignment.workspace_id,
        )
        project_role(source, user, owner=True)
    if revision.provenance != "shared_room_capture" or revision.manifest_version != 1:
        raise NotFound("Starter unavailable.")
    return revision


def verify_runtime(revision: ProjectRevision) -> None:
    try:
        valid = (
            revision.runtime_profile.enabled
            and runtime_identity(revision.runtime_profile) == revision.runtime_identity
            and revision.runtime_profile.manifest == revision.runtime_manifest
            and revision.helper_release == HELPER_RELEASE
        )
    except RevisionContractError:
        valid = False
    if not valid:
        raise ValidationError(
            {
                "detail": "This frozen starter's reviewed runtime is unavailable for publication."
            }
        )


@transaction.atomic
def create_assignment(
    user: User, session_key: str | None, workspace_id: uuid.UUID, *, title: str
) -> Assignment:
    workspace = lock_workspace(workspace_id)
    current = current_actor(user, session_key)
    require_assignment_teacher(workspace, current)
    require_open(workspace)
    if (
        Assignment.objects.filter(workspace=workspace).count()
        >= contracts.MAX_ASSIGNMENTS
    ):
        raise AssignmentCapacity(
            "assignment_capacity",
            "This workspace has reached its limit of 100 assignments.",
        )
    return Assignment.objects.create(
        workspace=workspace, created_by=current, draft_title=contracts.label(title, 120)
    )


@transaction.atomic
def archive_assignment(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    expected_revision: int,
    archived: bool,
) -> Assignment:
    assignment = lock_assignment(assignment_id)
    require_assignment_teacher(assignment.workspace, current_actor(user, session_key))
    require_open(assignment.workspace)
    check_revision(assignment, expected_revision)
    assignment.archived_at = timezone.now() if archived else None
    assignment.revision += 1
    assignment.save(update_fields=["archived_at", "revision", "updated_at"])
    return assignment


@transaction.atomic
def update_draft(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    expected_revision: int,
    **fields: Any,
) -> Assignment:
    assignment = lock_assignment(assignment_id)
    current = current_actor(user, session_key)
    require_assignment_teacher(assignment.workspace, current)
    require_assignment_mutable(assignment)
    check_revision(assignment, expected_revision)
    starter_id = fields.pop("starter_revision_id", assignment.draft_starter_revision_id)
    if starter_id is None:
        assignment.draft_starter_project = assignment.draft_starter_revision = None
    else:
        starter = authorize_starter_selection(assignment, starter_id, current)
        assignment.draft_starter_project_id, assignment.draft_starter_revision_id = (
            starter.project_id,
            starter.id,
        )
    for key, value in fields.items():
        setattr(assignment, f"draft_{key}", copy.deepcopy(value))
    if (
        assignment.draft_submission_mode == "individual"
        and assignment.draft_max_team_size != 1
    ) or (
        assignment.draft_submission_mode == "team"
        and not 2 <= assignment.draft_max_team_size <= 6
    ):
        raise ValidationError(
            {
                "detail": "Individual work requires size 1; team work requires size 2 through 6."
            }
        )
    require_assignment_teacher(assignment.workspace, current_actor(user, session_key))
    assignment.revision += 1
    assignment.save()
    return assignment


@transaction.atomic
def publish_version(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    expected_revision: int,
    client_request_id: uuid.UUID,
) -> tuple[AssignmentVersion, bool]:
    assignment = lock_assignment(assignment_id)
    current = current_actor(user, session_key)
    require_assignment_teacher(assignment.workspace, current)
    previous = AssignmentVersion.objects.filter(
        assignment=assignment, published_by=current, client_request_id=client_request_id
    ).first()
    if previous is not None:
        if previous.source_revision != expected_revision:
            raise AssignmentConflict()
        return previous, False
    require_assignment_mutable(assignment)
    check_revision(assignment, expected_revision)
    contracts.text(assignment.draft_instructions, 32768, nonblank=True)
    if assignment.draft_starter_revision_id is None:
        raise ValidationError(
            {"detail": "Choose a frozen starter revision before publishing."}
        )
    starter = authorize_starter_selection(
        assignment, assignment.draft_starter_revision_id, current
    )
    verify_runtime(starter)
    revision_manifest(
        starter
    )  # Revalidate immutable file/source identities, never Node/live source.
    retained = assignment.versions.aggregate(count=Count("id"), number=Max("number"))
    number = (retained["number"] or 0) + 1
    if retained["count"] >= contracts.MAX_VERSIONS or number > 50:
        raise AssignmentCapacity(
            "assignment_version_capacity",
            "This assignment has reached its limit of 50 published versions.",
        )
    current = current_actor(user, session_key)
    require_assignment_teacher(assignment.workspace, current)
    starter = authorize_starter_selection(assignment, starter.id, current)
    starter.runtime_profile = RuntimeProfile.objects.select_for_update().get(
        id=starter.runtime_profile_id
    )
    verify_runtime(starter)
    now = timezone.now()
    if assignment.draft_due_at is not None and assignment.draft_due_at <= now:
        raise ValidationError(
            {"detail": "Choose a future due date or no deadline before publishing."}
        )
    version = AssignmentVersion(
        assignment=assignment,
        workspace=assignment.workspace,
        number=number,
        published_by=current,
        author_display_name=public_display_name(current.display_name),
        published_at=now,
        client_request_id=client_request_id,
        source_revision=expected_revision,
        title=assignment.draft_title,
        instructions=assignment.draft_instructions,
        hints=copy.deepcopy(assignment.draft_hints),
        starter_project_id=starter.project_id,
        starter_revision=starter,
        starter_manifest_sha256=starter.manifest_sha256,
        runtime_profile=starter.runtime_profile,
        runtime_identity=copy.deepcopy(starter.runtime_identity),
        runtime_manifest=copy.deepcopy(starter.runtime_manifest),
        helper_release=copy.deepcopy(starter.helper_release),
        public_checks=contracts.public_checks(assignment.draft_public_checks_source),
        submission_mode=assignment.draft_submission_mode,
        max_attempts=assignment.draft_max_attempts,
        max_team_size=assignment.draft_max_team_size,
        due_at=assignment.draft_due_at,
    )
    version.content_sha256 = contracts.content_digest(version)
    version.metadata_bytes = contracts.metadata_size(version)
    if version.metadata_bytes > contracts.MAX_VERSION_METADATA:
        raise AssignmentCapacity(
            "assignment_version_metadata_limit",
            "Published version metadata exceeds 256 KiB. Reduce the draft content before publishing.",
        )
    if (
        assignment.published_metadata_bytes + version.metadata_bytes
        > contracts.MAX_ASSIGNMENT_METADATA
    ):
        raise AssignmentCapacity(
            "assignment_metadata_capacity",
            "This assignment has reached its 4 MiB published metadata limit.",
        )
    require_assignment_teacher(assignment.workspace, current_actor(user, session_key))
    version.save(force_insert=True)
    assignment.published_metadata_bytes += version.metadata_bytes
    assignment.current_version = version
    assignment.revision += 1
    assignment.save(
        update_fields=[
            "current_version",
            "published_metadata_bytes",
            "revision",
            "updated_at",
        ]
    )
    return version, True

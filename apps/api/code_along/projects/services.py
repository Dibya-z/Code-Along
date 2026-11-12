import uuid

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, NotFound, ValidationError

from code_along.accounts.models import User
from code_along.workspaces.models import Workspace, WorkspaceMembership
from code_along.workspaces.policies import require_membership
from code_along.workspaces.services import lock_workspace, require_open

from .models import (
    CollaborationDocument,
    Project,
    ProjectAccess,
    ProjectFile,
    RuntimeProfile,
)
from .policies import project_role
from .runtime_catalog import PROFILE_ID
from .validation import MAX_PROJECT_BYTES, source_digest, validate_paths

STARTER = (
    'def greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("Code Along"))\n'
)


class MetadataConflict(APIException):
    status_code = 409
    default_detail = "Project metadata changed. Refresh and try again."
    default_code = "metadata_conflict"


def lock_project(project_id: uuid.UUID) -> Project:
    workspace_id = (
        Project.objects.filter(id=project_id)
        .values_list("workspace_id", flat=True)
        .first()
    )
    if workspace_id is None:
        raise NotFound("Project unavailable.")
    lock_workspace(workspace_id)
    return (
        Project.objects.select_for_update(of=("self",))
        .select_related("workspace", "runtime_profile")
        .get(id=project_id)
    )


def check_version(project: Project, expected_version: int) -> None:
    if project.metadata_version != expected_version:
        raise MetadataConflict()


def bump_metadata(project: Project) -> None:
    if project.metadata_version >= 9007199254740991:
        raise ValidationError({"detail": "Project metadata revision limit reached."})
    project.metadata_version += 1
    project.save(update_fields=["metadata_version", "updated_at"])


def require_editable(project: Project) -> None:
    require_open(project.workspace)
    if project.archived_at is not None:
        raise ValidationError({"detail": "Restore this project before changing files."})


def file_for_project(project: Project, file_id: uuid.UUID) -> ProjectFile:
    try:
        return ProjectFile.objects.select_related("document").get(
            id=file_id, project=project, deleted_at__isnull=True
        )
    except ProjectFile.DoesNotExist:
        raise NotFound("File unavailable.") from None


@transaction.atomic
def create_project(
    user: User,
    workspace_id: uuid.UUID,
    name: str,
    runtime_profile_id: uuid.UUID = PROFILE_ID,
) -> Project:
    workspace = lock_workspace(workspace_id)
    require_membership(workspace, user)
    require_open(workspace)
    try:
        profile = RuntimeProfile.objects.get(id=runtime_profile_id, enabled=True)
    except RuntimeProfile.DoesNotExist:
        raise ValidationError(
            {"runtime_profile_id": "Choose an enabled runtime profile."}
        ) from None
    file_id = uuid.uuid4()
    # PostgreSQL's deferred FKs allow this complete cyclic association at COMMIT.
    project = Project.objects.create(
        workspace=workspace,
        owner=user,
        name=name,
        runtime_profile=profile,
        entrypoint_file_id=file_id,
    )
    _, digest = source_digest(STARTER)
    file = ProjectFile.objects.create(
        id=file_id,
        project=project,
        path="main.py",
        initial_source=STARTER,
        initial_sha256=digest,
    )
    CollaborationDocument.objects.create(project=project, file=file)
    return project


@transaction.atomic
def update_project(
    user: User,
    project_id: uuid.UUID,
    expected_version: int,
    *,
    name: str | None = None,
    archived: bool | None = None,
    entrypoint_file_id: uuid.UUID | None = None,
) -> Project:
    project = lock_project(project_id)
    project_role(
        project, user, owner=name is not None or archived is not None, write=True
    )
    require_open(project.workspace)
    check_version(project, expected_version)
    if name is None and archived is None and entrypoint_file_id is None:
        raise ValidationError({"detail": "Choose a metadata change."})
    if name is not None:
        project.name = name
    if archived is not None:
        project.archived_at = timezone.now() if archived else None
    if entrypoint_file_id is not None:
        require_editable(project)
        project.entrypoint_file = file_for_project(project, entrypoint_file_id)
    project.save(update_fields=["name", "archived_at", "entrypoint_file", "updated_at"])
    bump_metadata(project)
    return project


@transaction.atomic
def add_file(
    user: User,
    project_id: uuid.UUID,
    expected_version: int,
    path: str,
    initial_source: str = "",
) -> ProjectFile:
    project = lock_project(project_id)
    project_role(project, user, write=True)
    require_editable(project)
    check_version(project, expected_version)
    files = list(
        project.files.filter(deleted_at__isnull=True).only("path", "initial_source")
    )
    validate_paths([f.path for f in files] + [path])
    length, digest = source_digest(initial_source)
    if (
        sum(len(f.initial_source.encode("utf-8")) for f in files) + length
        > MAX_PROJECT_BYTES
    ):
        raise ValidationError(
            {"initial_source": "Project starter sources exceed 1 MiB."}
        )
    file = ProjectFile.objects.create(
        project=project, path=path, initial_source=initial_source, initial_sha256=digest
    )
    CollaborationDocument.objects.create(project=project, file=file)
    bump_metadata(project)
    return file


@transaction.atomic
def rename_file(
    user: User,
    project_id: uuid.UUID,
    file_id: uuid.UUID,
    expected_version: int,
    path: str,
) -> ProjectFile:
    project = lock_project(project_id)
    project_role(project, user, write=True)
    require_editable(project)
    check_version(project, expected_version)
    file = file_for_project(project, file_id)
    paths = list(
        project.files.filter(deleted_at__isnull=True)
        .exclude(id=file.id)
        .values_list("path", flat=True)
    )
    validate_paths([*paths, path])
    file.path = path
    file.save(update_fields=["path"])
    bump_metadata(project)
    return file


@transaction.atomic
def delete_file(
    user: User, project_id: uuid.UUID, file_id: uuid.UUID, expected_version: int
) -> None:
    project = lock_project(project_id)
    project_role(project, user, write=True)
    require_editable(project)
    check_version(project, expected_version)
    file = file_for_project(project, file_id)
    if project.entrypoint_file_id == file.id:
        raise ValidationError(
            {"detail": "Choose another entrypoint before deleting this file."}
        )
    file.deleted_at = timezone.now()
    file.save(update_fields=["deleted_at"])
    bump_metadata(project)


@transaction.atomic
def set_grant(user: User, project_id: uuid.UUID, user_id: uuid.UUID, role: str) -> None:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    require_editable(project)
    if role not in {"editor", "viewer"}:
        raise ValidationError({"role": "Choose editor or viewer."})
    if user_id == project.owner_id:
        raise ValidationError({"detail": "The project owner has implicit access."})
    if not WorkspaceMembership.objects.filter(
        workspace=project.workspace, user_id=user_id, active=True, user__is_active=True
    ).exists():
        raise ValidationError({"user_id": "Choose an active workspace member."})
    ProjectAccess.objects.update_or_create(
        project=project, user_id=user_id, defaults={"role": role}
    )
    project.acl_version += 1
    project.save(update_fields=["acl_version", "updated_at"])


@transaction.atomic
def revoke_grant(user: User, project_id: uuid.UUID, user_id: uuid.UUID) -> None:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    require_open(project.workspace)
    if user_id == project.owner_id:
        raise ValidationError(
            {"detail": "Transfer project ownership before removing owner access."}
        )
    ProjectAccess.objects.filter(project=project, user_id=user_id).delete()
    project.acl_version += 1
    project.save(update_fields=["acl_version", "updated_at"])


@transaction.atomic
def transfer_project(
    user: User, project_id: uuid.UUID, new_owner_id: uuid.UUID, expected_version: int
) -> Project:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    require_open(project.workspace)
    check_version(project, expected_version)
    if new_owner_id == project.owner_id:
        return project
    if not WorkspaceMembership.objects.filter(
        workspace=project.workspace,
        user_id=new_owner_id,
        active=True,
        user__is_active=True,
    ).exists():
        raise ValidationError({"new_owner_id": "Choose an active workspace member."})
    ProjectAccess.objects.filter(project=project, user_id=new_owner_id).delete()
    ProjectAccess.objects.update_or_create(
        project=project, user=user, defaults={"role": "editor"}
    )
    project.owner_id = new_owner_id
    project.acl_version += 1
    project.save(update_fields=["owner", "acl_version", "updated_at"])
    bump_metadata(project)
    return project


def guard_member_removal(workspace: Workspace, user_id: uuid.UUID) -> None:
    if Project.objects.filter(workspace=workspace, owner_id=user_id).exists():
        raise ValidationError(
            {
                "detail": "Transfer all projects owned by this member before removing workspace access."
            }
        )
    ids = ProjectAccess.objects.filter(
        project__workspace=workspace, user_id=user_id
    ).values_list("project_id", flat=True)
    from django.db.models import F

    Project.objects.filter(id__in=ids).update(acl_version=F("acl_version") + 1)
    ProjectAccess.objects.filter(project__workspace=workspace, user_id=user_id).delete()

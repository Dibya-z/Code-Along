import copy
import uuid
from typing import Any

from django.db import transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import APIException, PermissionDenied, ValidationError

from code_along.accounts.models import User
from code_along.collaboration.control import ControlUnavailable, post_control
from code_along.collaboration.profiles import public_display_name
from code_along.collaboration.services import AdmissionError, session_user
from code_along.workspaces.policies import require_membership
from code_along.workspaces.services import require_open

from .models import Project, ProjectRevision, RevisionFile
from .policies import project_role, visible_projects
from .revision_contract import (
    HELPER_RELEASE,
    RevisionContractError,
    runtime_identity,
    source_digest,
    validate_manifest,
)
from .revision_scopes import project_revisions
from .services import check_version, lock_project, require_editable

MAX_REVISIONS = 100
MAX_REVISION_BYTES = 32 * 1024 * 1024
MAX_CAPTURE_BYTES = 6 * 1024 * 1024 + 64 * 1024


class RevisionConflict(APIException):
    status_code = 409
    default_detail = "This revision request changed. Use a new request identity."


class RevisionUnavailable(APIException):
    status_code = 503
    default_detail = (
        "The shared source could not be captured. Keep your code open and try again."
    )


class RevisionLimit(APIException):
    status_code = 429
    default_detail = "This project's named revision storage limit was reached."


def current_actor(user: User, session_key: str | None) -> User:
    try:
        current, _ = session_user(session_key)
    except AdmissionError:
        raise PermissionDenied("Refresh your verified session and try again.") from None
    if current.id != user.id:
        raise PermissionDenied("Refresh your verified session and try again.")
    return current


def descriptor(project: Project) -> dict[str, Any]:
    files = sorted(
        project.files.filter(deleted_at__isnull=True).select_related("document"),
        key=lambda file: file.path,
    )
    return {
        "version": 1,
        "capture_id": str(uuid.uuid4()),
        "project_id": str(project.id),
        "metadata_version": project.metadata_version,
        "entrypoint_file_id": str(project.entrypoint_file_id),
        "runtime": runtime_identity(project.runtime_profile),
        "helper_release": dict(HELPER_RELEASE),
        "files": [
            {
                "file_id": str(file.id),
                "document_id": str(file.document.id),
                "generation": file.generation,
                "path": file.path,
                "initial_source": file.initial_source,
                "initial_sha256": file.initial_sha256,
            }
            for file in files
        ],
    }


def existing_request(
    project: Project,
    user: User,
    request_id: uuid.UUID,
    name: str,
    expected_version: int,
) -> ProjectRevision | None:
    revision = (
        project_revisions()
        .filter(project=project, author=user, client_request_id=request_id)
        .first()
    )
    if revision is not None and (
        revision.name != name or revision.metadata_version != expected_version
    ):
        raise RevisionConflict()
    return revision


def capture(described: dict[str, Any]) -> dict[str, Any]:
    try:
        result = post_control(
            "/internal/v1/captures/", described, maximum=MAX_CAPTURE_BYTES, timeout=10
        )
        if (
            set(result) != {"version", "capture_id", "manifest"}
            or type(result["version"]) is not int
            or result["version"] != 1
            or result["capture_id"] != described["capture_id"]
        ):
            raise RevisionContractError()
        return validate_manifest(result["manifest"])
    except (ControlUnavailable, RevisionContractError):
        raise RevisionUnavailable() from None


def verify_capture(
    project: Project, described: dict[str, Any], manifest: dict[str, Any]
) -> None:
    current = descriptor(project)
    current.pop("capture_id")
    original = {key: value for key, value in described.items() if key != "capture_id"}
    if current != original:
        raise RevisionConflict()
    for key in (
        "project_id",
        "metadata_version",
        "entrypoint_file_id",
        "runtime",
        "helper_release",
    ):
        if manifest[key] != described[key]:
            raise RevisionUnavailable()
    actual_files = [
        {key: file[key] for key in ("file_id", "document_id", "generation", "path")}
        for file in manifest["files"]
    ]
    expected_files = [
        {key: file[key] for key in ("file_id", "document_id", "generation", "path")}
        for file in described["files"]
    ]
    if actual_files != expected_files:
        raise RevisionUnavailable()


def create_revision(
    user: User,
    session_key: str | None,
    project_id: uuid.UUID,
    *,
    name: str,
    expected_version: int,
    client_request_id: uuid.UUID,
) -> tuple[ProjectRevision, bool]:
    # Copy authorized metadata while locked, then leave the transaction before Node I/O.
    with transaction.atomic():
        project = lock_project(project_id)
        current = current_actor(user, session_key)
        project_role(project, current, write=True)
        require_editable(project)
        old = existing_request(
            project, current, client_request_id, name, expected_version
        )
        if old is not None:
            return old, False
        check_version(project, expected_version)
        try:
            described = descriptor(project)
        except RevisionContractError:
            raise RevisionUnavailable() from None
        frozen_runtime = copy.deepcopy(project.runtime_profile.manifest)
    manifest = capture(described)
    with transaction.atomic():
        project = lock_project(project_id)
        current = current_actor(
            user, session_key
        )  # Cached request.user is not sufficient here.
        project_role(project, current, write=True)
        require_editable(project)
        old = existing_request(
            project, current, client_request_id, name, expected_version
        )
        if old is not None:
            return old, False
        check_version(project, expected_version)
        try:
            verify_capture(project, described, manifest)
        except RevisionContractError:
            raise RevisionUnavailable() from None
        if project.runtime_profile.manifest != frozen_runtime:
            raise RevisionConflict()
        total = sum(source_digest(file["source"])[0] for file in manifest["files"])
        history = project_revisions().filter(project=project)
        stored = history.aggregate(total=Sum("source_bytes"))["total"] or 0
        if history.count() >= MAX_REVISIONS or stored + total > MAX_REVISION_BYTES:
            raise RevisionLimit()
        revision = ProjectRevision.objects.create(
            artifact_scope="project",
            provenance="shared_room_capture",
            project=project,
            author=current,
            author_display_name=public_display_name(current.display_name),
            client_request_id=client_request_id,
            name=name,
            manifest_sha256=manifest["sha256"],
            metadata_version=expected_version,
            entrypoint_file_id=project.entrypoint_file_id,
            runtime_profile=project.runtime_profile,
            runtime_identity=manifest["runtime"],
            runtime_manifest=frozen_runtime,
            helper_release=manifest["helper_release"],
            source_bytes=total,
        )
        RevisionFile.objects.bulk_create(
            [
                RevisionFile(
                    revision=revision,
                    file_id=file["file_id"],
                    document_id=file["document_id"],
                    generation=file["generation"],
                    path=file["path"],
                    source=file["source"],
                    source_sha256=file["sha256"],
                    source_bytes=source_digest(file["source"])[0],
                )
                for file in manifest["files"]
            ]
        )
        from code_along.events.services import emit_project_event

        emit_project_event(
            project, "revision.created", {"revision_id": str(revision.id)}
        )
        return revision, True


def revision_manifest(revision: ProjectRevision) -> dict[str, Any]:
    """Internal serialization only; the caller separately authorizes this artifact."""
    try:
        return validate_manifest(
            {
                "protocol": "code-along.revision",
                "version": revision.manifest_version,
                "project_id": str(revision.project_id),
                "metadata_version": revision.metadata_version,
                "entrypoint_file_id": str(revision.entrypoint_file_id),
                "runtime": revision.runtime_identity,
                "helper_release": revision.helper_release,
                "files": [
                    {
                        "file_id": str(file.file_id),
                        "document_id": str(file.document_id),
                        "generation": file.generation,
                        "path": file.path,
                        "source": file.source,
                        "sha256": file.source_sha256,
                    }
                    for file in sorted(revision.files.all(), key=lambda file: file.path)
                ],
                "sha256": revision.manifest_sha256,
            }
        )
    except RevisionContractError:
        raise RevisionUnavailable() from None


def readable_revision(
    user: User, project_id: uuid.UUID, revision_id: uuid.UUID
) -> ProjectRevision:
    project = get_object_or_404(visible_projects(user), id=project_id)
    project_role(project, user)
    return get_object_or_404(
        project_revisions().select_related("project", "runtime_profile"),
        project=project,
        id=revision_id,
    )


@transaction.atomic
def copy_revision(
    user: User,
    session_key: str | None,
    project_id: uuid.UUID,
    revision_id: uuid.UUID,
    *,
    name: str,
) -> Project:
    source = lock_project(project_id)
    current = current_actor(user, session_key)
    project_role(source, current)
    require_membership(source.workspace, current)
    require_open(source.workspace)
    revision = get_object_or_404(
        project_revisions().select_related("runtime_profile"),
        project=source,
        id=revision_id,
    )
    manifest = revision_manifest(revision)
    profile = revision.runtime_profile
    if (
        not profile.enabled
        or runtime_identity(profile) != revision.runtime_identity
        or profile.manifest != revision.runtime_manifest
    ):
        raise ValidationError(
            {
                "detail": "This historical runtime is unavailable for a new project. Export its source instead."
            }
        )
    from .frozen_projects import create_from_manifest

    return create_from_manifest(
        source.workspace, current, name=name, profile=profile, manifest=manifest
    )

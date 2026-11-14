"""Internal construction after the caller authorizes a frozen source bundle."""

import uuid
from typing import Any

from django.db import connection
from rest_framework.exceptions import ValidationError

from code_along.accounts.models import User
from code_along.workspaces.models import Workspace

from .models import CollaborationDocument, Project, ProjectFile, RuntimeProfile
from .revision_contract import HELPER_RELEASE, runtime_identity, validate_manifest


def create_from_manifest(
    workspace: Workspace,
    owner: User,
    *,
    name: str,
    profile: RuntimeProfile,
    manifest: dict[str, Any],
) -> Project:
    """Caller holds workspace/authority locks and owns the surrounding transaction."""
    if not connection.in_atomic_block:
        raise RuntimeError(
            "Frozen project construction requires an atomic transaction."
        )
    manifest = validate_manifest(manifest)
    if (
        not profile.enabled
        or runtime_identity(profile) != manifest["runtime"]
        or manifest["helper_release"] != HELPER_RELEASE
    ):
        raise ValidationError(
            {"detail": "This frozen runtime is unavailable for a new project."}
        )
    identifiers = {file["file_id"]: uuid.uuid4() for file in manifest["files"]}
    copied = Project.objects.create(
        workspace=workspace,
        owner=owner,
        name=name,
        runtime_profile=profile,
        entrypoint_file_id=identifiers[manifest["entrypoint_file_id"]],
    )
    for source_file in manifest["files"]:
        file = ProjectFile.objects.create(
            id=identifiers[source_file["file_id"]],
            project=copied,
            path=source_file["path"],
            initial_source=source_file["source"],
            initial_sha256=source_file["sha256"],
        )
        CollaborationDocument.objects.create(project=copied, file=file)
    from code_along.events.services import project_changed

    project_changed(copied)
    return copied

import hashlib
import secrets
import uuid
from datetime import timedelta
from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from code_along.accounts.models import User
from code_along.collaboration.services import revoke_leases
from code_along.workspaces.models import WorkspaceMembership

from .api import file_data
from .models import ShareGrant
from .policies import project_role
from .revision_scopes import project_revisions, public_shares, require_public_share
from .revision_services import RevisionLimit, current_actor, revision_manifest
from .services import lock_project, require_editable
from .source_access import source_share


@transaction.atomic
def create_share(
    user: User,
    project_id: uuid.UUID,
    *,
    kind: str,
    scope: str,
    revision_id: uuid.UUID | None,
    recipient_id: uuid.UUID | None,
    expires_hours: int,
) -> tuple[ShareGrant, str]:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    require_editable(project)
    if (kind == "snapshot" and (scope != "read" or revision_id is None)) or (
        kind == "live" and revision_id is not None
    ):
        raise ValidationError(
            {
                "detail": "Snapshot links view one revision; live links address current source."
            }
        )
    revision = (
        get_object_or_404(project_revisions(), project=project, id=revision_id)
        if kind == "snapshot"
        else None
    )
    if (
        recipient_id is not None
        and not WorkspaceMembership.objects.filter(
            workspace=project.workspace,
            user_id=recipient_id,
            active=True,
            user__is_active=True,
        ).exists()
    ):
        raise ValidationError({"recipient_id": "Choose an active workspace member."})
    if (
        public_shares()
        .filter(project=project, revoked_at__isnull=True, expires_at__gt=timezone.now())
        .count()
        >= 100
    ):
        raise RevisionLimit("This project's active share limit was reached.")
    token = secrets.token_urlsafe(32)
    share = ShareGrant.objects.create(
        project=project,
        revision=revision,
        revision_scope="project",
        created_by=user,
        recipient_id=recipient_id,
        kind=kind,
        scope=scope,
        token_digest=hashlib.sha256(token.encode("ascii")).hexdigest(),
        expires_at=timezone.now() + timedelta(hours=expires_hours),
    )
    from code_along.events.services import project_access_changed

    project_access_changed(project)
    return share, token


@transaction.atomic
def revoke_share(user: User, project_id: uuid.UUID, share_id: uuid.UUID) -> None:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    share = get_object_or_404(ShareGrant, project=project, id=share_id)
    if share.revoked_at is None:
        share.revoked_at = timezone.now()
        share.save(update_fields=["revoked_at"])
        revoke_leases(share_grant_id=share.id)
        from code_along.events.services import project_access_changed

        project_access_changed(project)


@transaction.atomic
def resolve_share(
    token: str, user: User | None, session_key: str | None
) -> dict[str, Any]:
    digest = hashlib.sha256(token.encode("ascii")).hexdigest()
    candidate = public_shares().filter(token_digest=digest).first()
    if candidate is None:
        raise PermissionDenied("Shared source unavailable.")
    project = lock_project(candidate.project_id)
    share = public_shares().filter(id=candidate.id).first()
    if share is None:
        raise PermissionDenied("Shared source unavailable.")
    require_public_share(share)
    if share.revoked_at is not None or share.expires_at <= timezone.now():
        raise PermissionDenied("Shared source unavailable.")
    if share.kind == "live" or share.recipient_id is not None:
        if user is None:
            raise PermissionDenied("Sign in with a verified account to open this link.")
        user = current_actor(user, session_key)
        if share.recipient_id is not None and share.recipient_id != user.id:
            raise PermissionDenied("Shared source unavailable.")
    common = {
        "kind": share.kind,
        "share_id": str(share.id),
        "expires_at": share.expires_at,
    }
    if share.kind == "snapshot":
        revision = share.revision
        assert revision is not None
        return {
            **common,
            "revision": {
                "id": str(revision.id),
                "name": revision.name,
                "created_at": revision.created_at,
                "manifest": revision_manifest(revision),
            },
        }
    assert user is not None
    source_share(project, user, "read", share_id=share.id)
    files = (
        project.files.filter(deleted_at__isnull=True)
        .select_related("document")
        .order_by("path")
    )
    return {
        **common,
        "scope": share.scope,
        "project": {
            "id": str(project.id),
            "name": project.name,
            "entrypoint_file_id": str(project.entrypoint_file_id),
            "metadata_version": project.metadata_version,
            "runtime_id": project.runtime_profile.runtime_id,
            "archived": project.archived_at is not None,
            "workspace_archived": project.workspace.archived_at is not None,
            "access": {"kind": "live_share", "scope": share.scope},
        },
        "files": {
            "items": [file_data(file, source=True) for file in files],
            "count": files.count(),
        },
    }

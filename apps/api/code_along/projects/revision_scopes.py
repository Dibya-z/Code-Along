"""Artifact boundaries supplement, rather than replace, source authorization."""

from django.db.models import Q, QuerySet
from rest_framework.exceptions import NotFound

from .models import ProjectRevision, ShareGrant


def project_revisions() -> QuerySet[ProjectRevision]:
    return ProjectRevision.objects.filter(
        artifact_scope="project", provenance="shared_room_capture", manifest_version=1
    )


def require_project_revision(revision: ProjectRevision) -> None:
    if (
        revision.artifact_scope != "project"
        or revision.provenance != "shared_room_capture"
        or revision.manifest_version != 1
    ):
        raise NotFound("Revision unavailable.")


def public_shares() -> QuerySet[ShareGrant]:
    return (
        ShareGrant.objects.filter(revision_scope="project")
        .filter(
            Q(kind="live", revision__isnull=True, scope__in=["read", "write"])
            | Q(
                kind="snapshot",
                scope="read",
                revision__artifact_scope="project",
                revision__provenance="shared_room_capture",
                revision__manifest_version=1,
            )
        )
        .select_related("revision")
    )


def require_public_share(share: ShareGrant) -> None:
    if share.revision_scope != "project":
        raise NotFound("Shared source unavailable.")
    if share.kind == "snapshot":
        if share.revision is None or share.scope != "read":
            raise NotFound("Shared source unavailable.")
        require_project_revision(share.revision)
    elif (
        share.kind != "live"
        or share.revision_id is not None
        or share.scope not in {"read", "write"}
    ):
        raise NotFound("Shared source unavailable.")

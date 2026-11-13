"""A chosen live link authorizes source only, never ordinary project actions."""

import hashlib
import uuid

from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from code_along.accounts.models import User
from code_along.workspaces.policies import require_membership

from .models import Project, ShareGrant


def source_share(
    project: Project,
    user: User,
    scope: str,
    *,
    token: str | None = None,
    share_id: uuid.UUID | None = None,
) -> ShareGrant:
    require_membership(project.workspace, user)
    query = ShareGrant.objects.filter(
        project=project,
        kind="live",
        revoked_at__isnull=True,
        expires_at__gt=timezone.now(),
    )
    if token is not None:
        query = query.filter(
            token_digest=hashlib.sha256(token.encode("ascii")).hexdigest()
        )
    elif share_id is not None:
        query = query.filter(id=share_id)
    else:
        raise PermissionDenied("Shared source unavailable.")
    share = query.first()
    if (
        share is None
        or (share.recipient_id is not None and share.recipient_id != user.id)
        or (scope == "write" and share.scope != "write")
    ):
        raise PermissionDenied("Shared source unavailable.")
    return share

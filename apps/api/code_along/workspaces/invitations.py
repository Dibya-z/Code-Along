import hashlib
import re
import secrets
import uuid
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import NotFound, ValidationError

from code_along.accounts.managers import UserManager
from code_along.accounts.models import User

from .models import Workspace, WorkspaceInvitation, WorkspaceMembership
from .policies import require_membership
from .services import bump_acl, lock_workspace, require_open


def digest(token: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        raise NotFound("Invitation unavailable.")
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def invitation_for_token(token: str) -> WorkspaceInvitation:
    invitation = WorkspaceInvitation.objects.filter(token_digest=digest(token)).first()
    if invitation is None:
        raise NotFound("Invitation unavailable.")
    return invitation


def validate_invitation(invitation: WorkspaceInvitation, user: User) -> None:
    if invitation.project_id:
        from code_along.projects.models import ProjectAccess

        project = invitation.project
        if project is None or project.archived_at is not None:
            raise NotFound("Invitation unavailable.")
        if not WorkspaceMembership.objects.filter(
            workspace=project.workspace, user=user, active=True
        ).exists():
            raise NotFound("Invitation unavailable.")
        if (
            invitation.accepted_at
            and project.owner_id != user.id
            and not ProjectAccess.objects.filter(project=project, user=user).exists()
        ):
            raise NotFound("Invitation unavailable.")
    if (
        invitation.recipient_email != user.email
        or invitation.revoked_at is not None
        or invitation.workspace.archived_at is not None
    ):
        raise NotFound("Invitation unavailable.")
    if invitation.accepted_at:
        if (
            invitation.accepted_by_id != user.id
            or not WorkspaceMembership.objects.filter(
                workspace=invitation.workspace, user=user, active=True
            ).exists()
        ):
            raise NotFound("Invitation unavailable.")
    elif invitation.expires_at <= timezone.now():
        raise NotFound("Invitation unavailable.")


@transaction.atomic
def create_invitation(
    user: User,
    workspace_id: uuid.UUID,
    recipient_email: str,
    role: str,
    expires_hours: int,
) -> tuple[WorkspaceInvitation, str]:
    workspace = lock_workspace(workspace_id)
    require_membership(workspace, user, owner=True)
    require_open(workspace)
    try:
        email = UserManager.normalize_email(recipient_email)
    except ValueError as error:
        raise ValidationError(
            {"recipient_email": "Enter a valid email address."}
        ) from error
    if role not in {"instructor", "learner"} or not 1 <= expires_hours <= 168:
        raise ValidationError({"detail": "Invalid invitation role or expiry."})
    token = secrets.token_urlsafe(32)
    invitation = WorkspaceInvitation.objects.create(
        workspace=workspace,
        created_by=user,
        recipient_email=email,
        role=role,
        token_digest=digest(token),
        expires_at=timezone.now() + timedelta(hours=expires_hours),
    )
    return invitation, token


@transaction.atomic
def revoke_invitation(
    user: User, workspace_id: uuid.UUID, invitation_id: uuid.UUID
) -> None:
    workspace = lock_workspace(workspace_id)
    require_membership(workspace, user, owner=True)
    invitation = WorkspaceInvitation.objects.filter(
        workspace=workspace, id=invitation_id, project__isnull=True
    ).first()
    if invitation is None:
        raise NotFound("Invitation unavailable.")
    if invitation.accepted_at:
        raise ValidationError(
            {
                "detail": "This invitation was accepted. Remove the membership to revoke access."
            }
        )
    if invitation.revoked_at is None:
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=["revoked_at"])


@transaction.atomic
def accept_invitation(user: User, token: str) -> Workspace:
    candidate = invitation_for_token(token)
    workspace = lock_workspace(candidate.workspace_id)
    invitation = (
        WorkspaceInvitation.objects.select_for_update()
        .select_related("workspace")
        .get(id=candidate.id)
    )
    validate_invitation(invitation, user)
    if invitation.accepted_at:
        return workspace
    if invitation.project_id:
        from code_along.projects.models import ProjectAccess

        if invitation.project is not None and invitation.project.owner_id != user.id:
            ProjectAccess.objects.get_or_create(
                project=invitation.project,
                user=user,
                defaults={"role": invitation.role},
            )
        from django.db.models import F

        from code_along.projects.models import Project

        Project.objects.filter(id=invitation.project_id).update(
            acl_version=F("acl_version") + 1
        )
    else:
        member, created = WorkspaceMembership.objects.get_or_create(
            workspace=workspace, user=user, defaults={"role": invitation.role}
        )
        if not created and not member.active:
            member.active = True
            member.role = invitation.role
            member.save(update_fields=["active", "role"])
    # Existing active membership keeps its role; invitations cannot silently replace it.
    invitation.accepted_by = user
    invitation.accepted_at = timezone.now()
    invitation.save(update_fields=["accepted_by", "accepted_at"])
    bump_acl(workspace)
    return workspace

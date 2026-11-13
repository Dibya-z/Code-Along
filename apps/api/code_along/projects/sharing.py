import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema_view
from rest_framework import serializers
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.accounts.managers import UserManager
from code_along.accounts.models import User
from code_along.common import schemas as dto
from code_along.common.api import BodySerializer, actor, page_values
from code_along.common.schema_helpers import endpoint
from code_along.workspaces.invitation_api import invitation_data
from code_along.workspaces.invitations import digest
from code_along.workspaces.models import WorkspaceInvitation, WorkspaceMembership

from .policies import project_role, visible_projects
from .services import lock_project, require_editable


class ProjectInvitationBody(BodySerializer):
    recipient_email = serializers.EmailField(max_length=254)
    role = serializers.ChoiceField(choices=["editor", "viewer"], default="viewer")
    expires_hours = serializers.IntegerField(min_value=1, max_value=168, default=72)


@transaction.atomic
def create_project_invitation(
    user: User,
    project_id: uuid.UUID,
    recipient_email: str,
    role: str,
    expires_hours: int,
) -> tuple[WorkspaceInvitation, str]:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    require_editable(project)
    try:
        email = UserManager.normalize_email(recipient_email)
    except ValueError as error:
        raise ValidationError(
            {"recipient_email": "Enter a valid email address."}
        ) from error
    if role not in {"editor", "viewer"} or not 1 <= expires_hours <= 168:
        raise ValidationError({"detail": "Invalid project invitation role or expiry."})
    if email == user.email:
        raise ValidationError(
            {"detail": "The owner already has implicit project access."}
        )
    if not WorkspaceMembership.objects.filter(
        workspace=project.workspace,
        user__email=email,
        user__is_active=True,
        active=True,
    ).exists():
        raise ValidationError(
            {"recipient_email": "Invite an active member of this workspace."}
        )
    token = secrets.token_urlsafe(32)
    invitation = WorkspaceInvitation.objects.create(
        project=project,
        workspace=project.workspace,
        created_by=user,
        recipient_email=email,
        role=role,
        token_digest=digest(token),
        expires_at=timezone.now() + timedelta(hours=expires_hours),
    )
    return invitation, token


@transaction.atomic
def revoke_project_invitation(
    user: User, project_id: uuid.UUID, invitation_id: uuid.UUID
) -> None:
    project = lock_project(project_id)
    project_role(project, user, owner=True)
    invitation = WorkspaceInvitation.objects.filter(
        project=project, id=invitation_id
    ).first()
    if invitation is None:
        raise NotFound("Invitation unavailable.")
    if invitation.accepted_at:
        raise ValidationError(
            {"detail": "Revoke the accepted project access grant instead."}
        )
    if invitation.revoked_at is None:
        invitation.revoked_at = timezone.now()
        invitation.save(update_fields=["revoked_at"])


@extend_schema_view(
    get=endpoint("list_project_invitations", dto.InvitationPage, paginated=True),
    post=endpoint(
        "create_project_invitation",
        dto.InvitationCreated,
        request=ProjectInvitationBody,
        status=201,
    ),
)
class ProjectInvitationListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(
            visible_projects(actor(request)).select_related("workspace"), id=project_id
        )
        project_role(project, actor(request), owner=True)
        offset, limit = page_values(request)
        query = project.invitations.all()
        return Response(
            {
                "items": [invitation_data(i) for i in query[offset : offset + limit]],
                "count": query.count(),
            }
        )

    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = ProjectInvitationBody(data=request.data)
        body.is_valid(raise_exception=True)
        invitation, token = create_project_invitation(
            actor(request), project_id, **body.validated_data
        )
        return Response(
            {
                "invitation": invitation_data(invitation),
                "invite_url": f"{settings.PUBLIC_APP_ORIGIN}/invitations/{token}",
            },
            status=201,
        )


@extend_schema_view(delete=endpoint("revoke_project_invitation", status=204))
class ProjectInvitationRevokeView(APIView):
    def delete(
        self, request: Request, project_id: uuid.UUID, invitation_id: uuid.UUID
    ) -> Response:
        revoke_project_invitation(actor(request), project_id, invitation_id)
        return Response(status=204)

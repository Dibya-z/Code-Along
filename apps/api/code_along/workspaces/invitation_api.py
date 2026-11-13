import uuid
from typing import Any

from django.conf import settings
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema_view
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common import schemas as dto
from code_along.common.api import BodySerializer, actor, page_values
from code_along.common.schema_helpers import endpoint

from . import invitations
from .models import WorkspaceInvitation
from .policies import require_membership, visible_workspaces


class InvitationBody(BodySerializer):
    recipient_email = serializers.EmailField(max_length=254)
    role = serializers.ChoiceField(choices=["instructor", "learner"], default="learner")
    expires_hours = serializers.IntegerField(min_value=1, max_value=168, default=72)


class TokenBody(BodySerializer):
    token = serializers.RegexField(r"^[A-Za-z0-9_-]{43}$", max_length=43)


def invitation_data(invitation: WorkspaceInvitation) -> dict[str, Any]:
    status = (
        "accepted"
        if invitation.accepted_at
        else "revoked"
        if invitation.revoked_at
        else "expired"
        if invitation.expires_at <= timezone.now()
        else "pending"
    )
    return {
        "id": str(invitation.id),
        "workspace_id": str(invitation.workspace_id),
        "project_id": str(invitation.project_id) if invitation.project_id else None,
        "recipient_email": invitation.recipient_email,
        "role": invitation.role,
        "expires_at": invitation.expires_at.isoformat(),
        "status": status,
    }


@extend_schema_view(
    get=endpoint("list_workspace_invitations", dto.InvitationPage, paginated=True),
    post=endpoint(
        "create_workspace_invitation",
        dto.InvitationCreated,
        request=InvitationBody,
        status=201,
    ),
)
class InvitationListView(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        workspace = get_object_or_404(
            visible_workspaces(actor(request)), id=workspace_id
        )
        require_membership(workspace, actor(request), owner=True)
        offset, limit = page_values(request)
        query = WorkspaceInvitation.objects.filter(
            workspace=workspace, project__isnull=True
        )
        return Response(
            {
                "items": [
                    invitation_data(item) for item in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )

    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        body = InvitationBody(data=request.data)
        body.is_valid(raise_exception=True)
        invitation, token = invitations.create_invitation(
            actor(request), workspace_id, **body.validated_data
        )
        return Response(
            {
                "invitation": invitation_data(invitation),
                "invite_url": f"{settings.PUBLIC_APP_ORIGIN}/invitations/{token}",
            },
            status=201,
        )


@extend_schema_view(delete=endpoint("revoke_workspace_invitation", status=204))
class InvitationRevokeView(APIView):
    def delete(
        self, request: Request, workspace_id: uuid.UUID, invitation_id: uuid.UUID
    ) -> Response:
        invitations.revoke_invitation(actor(request), workspace_id, invitation_id)
        return Response(status=204)


@extend_schema_view(
    post=endpoint("preview_invitation", dto.InvitationPreview, request=TokenBody)
)
class InvitationPreviewView(APIView):
    def post(self, request: Request) -> Response:
        body = TokenBody(data=request.data)
        body.is_valid(raise_exception=True)
        invitation = invitations.invitation_for_token(body.validated_data["token"])
        invitations.validate_invitation(invitation, actor(request))
        return Response(
            {
                "workspace_name": invitation.workspace.name,
                "project_name": invitation.project.name if invitation.project else None,
                "role": invitation.role,
                "accepted": invitation.accepted_at is not None,
            }
        )


@extend_schema_view(
    post=endpoint("accept_invitation", dto.InvitationAccepted, request=TokenBody)
)
class InvitationAcceptView(APIView):
    def post(self, request: Request) -> Response:
        body = TokenBody(data=request.data)
        body.is_valid(raise_exception=True)
        workspace = invitations.accept_invitation(
            actor(request), body.validated_data["token"]
        )
        invitation = invitations.invitation_for_token(body.validated_data["token"])
        return Response(
            {
                "workspace_id": str(workspace.id),
                "project_id": str(invitation.project_id)
                if invitation.project_id
                else None,
            }
        )

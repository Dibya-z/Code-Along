import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema_view
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common import schemas as dto
from code_along.common.api import BodySerializer, actor, page_values
from code_along.common.schema_helpers import endpoint

from . import services
from .models import Workspace, WorkspaceMembership
from .policies import require_membership, visible_workspaces


class WorkspaceBody(BodySerializer):
    name = serializers.CharField(max_length=100, trim_whitespace=True)


class WorkspaceUpdate(BodySerializer):
    name = serializers.CharField(max_length=100, required=False, trim_whitespace=True)
    archived = serializers.BooleanField(required=False)


class MemberBody(BodySerializer):
    role = serializers.ChoiceField(choices=["instructor", "learner"])


class WorkspaceTransferBody(BodySerializer):
    new_owner_id = serializers.UUIDField()


def workspace_data(workspace: Workspace, role: str) -> dict[str, Any]:
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "role": role,
        "archived": workspace.archived_at is not None,
        "acl_version": str(workspace.acl_version),
    }


@extend_schema_view(
    get=endpoint("list_workspaces", dto.WorkspacePage, paginated=True),
    post=endpoint(
        "create_workspace", dto.WorkspaceOutput, request=WorkspaceBody, status=201
    ),
)
class WorkspaceListView(APIView):
    def get(self, request: Request) -> Response:
        offset, limit = page_values(request)
        query = (
            WorkspaceMembership.objects.filter(user=actor(request), active=True)
            .select_related("workspace")
            .order_by("-workspace__created_at", "workspace_id")
        )
        return Response(
            {
                "items": [
                    workspace_data(item.workspace, item.role)
                    for item in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )

    def post(self, request: Request) -> Response:
        body = WorkspaceBody(data=request.data)
        body.is_valid(raise_exception=True)
        workspace = services.create_workspace(
            actor(request), body.validated_data["name"]
        )
        return Response(
            workspace_data(
                workspace, require_membership(workspace, actor(request)).role
            ),
            status=201,
        )


@extend_schema_view(
    get=endpoint("get_workspace", dto.WorkspaceOutput),
    patch=endpoint("update_workspace", dto.WorkspaceOutput, request=WorkspaceUpdate),
)
class WorkspaceDetailView(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        workspace = get_object_or_404(
            visible_workspaces(actor(request)), id=workspace_id
        )
        return Response(
            workspace_data(
                workspace, require_membership(workspace, actor(request)).role
            )
        )

    def patch(self, request: Request, workspace_id: uuid.UUID) -> Response:
        body = WorkspaceUpdate(data=request.data)
        body.is_valid(raise_exception=True)
        workspace = services.update_workspace(
            actor(request), workspace_id, **body.validated_data
        )
        return Response(
            workspace_data(
                workspace, require_membership(workspace, actor(request)).role
            )
        )


@extend_schema_view(
    get=endpoint("list_workspace_members", dto.MemberPage, paginated=True)
)
class MemberListView(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        workspace = get_object_or_404(
            visible_workspaces(actor(request)), id=workspace_id
        )
        offset, limit = page_values(request)
        query = WorkspaceMembership.objects.filter(
            workspace=workspace, active=True
        ).select_related("user")
        return Response(
            {
                "items": [
                    {
                        "user_id": str(m.user_id),
                        "display_name": m.user.display_name,
                        "role": m.role,
                    }
                    for m in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )


@extend_schema_view(
    patch=endpoint("update_workspace_member", request=MemberBody, status=204),
    delete=endpoint("remove_workspace_member", status=204),
)
class MemberDetailView(APIView):
    def patch(
        self, request: Request, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> Response:
        body = MemberBody(data=request.data)
        body.is_valid(raise_exception=True)
        services.update_member(
            actor(request), workspace_id, user_id, role=body.validated_data["role"]
        )
        return Response(status=204)

    def delete(
        self, request: Request, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> Response:
        services.update_member(actor(request), workspace_id, user_id, remove=True)
        return Response(status=204)


@extend_schema_view(
    post=endpoint(
        "transfer_workspace", dto.WorkspaceOutput, request=WorkspaceTransferBody
    )
)
class OwnershipView(APIView):
    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        body = WorkspaceTransferBody(data=request.data)
        body.is_valid(raise_exception=True)
        workspace = services.transfer_ownership(
            actor(request), workspace_id, body.validated_data["new_owner_id"]
        )
        return Response(
            workspace_data(
                workspace, require_membership(workspace, actor(request)).role
            )
        )

import uuid
from typing import Any

from django.conf import settings
from django.shortcuts import get_object_or_404
from drf_spectacular.utils import PolymorphicProxySerializer, extend_schema_view
from rest_framework import serializers
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.accounts.models import User
from code_along.collaboration.api import StrictIntegerField, StrictUUIDField
from code_along.common.api import BodySerializer, actor, page_values
from code_along.common.schema_helpers import endpoint

from . import revision_dto as dto
from . import share_services as services
from .models import ShareGrant
from .policies import project_role, visible_projects


class CreateShareBody(BodySerializer):
    kind = serializers.ChoiceField(choices=["live", "snapshot"])
    scope = serializers.ChoiceField(choices=["read", "write"])
    revision_id = StrictUUIDField(allow_null=True)
    recipient_id = StrictUUIDField(allow_null=True)
    expires_hours = StrictIntegerField(min_value=1, max_value=168)


class ResolveShareBody(BodySerializer):
    token = serializers.RegexField(r"^[A-Za-z0-9_-]{43}$", trim_whitespace=False)


def share_data(share: ShareGrant) -> dict[str, Any]:
    return {
        "id": str(share.id),
        "project_id": str(share.project_id),
        "kind": share.kind,
        "scope": share.scope,
        "revision_id": str(share.revision_id) if share.revision_id else None,
        "recipient_id": str(share.recipient_id) if share.recipient_id else None,
        "created_at": share.created_at,
        "expires_at": share.expires_at,
        "revoked": share.revoked_at is not None,
    }


@extend_schema_view(
    get=endpoint("list_project_shares", dto.SharePage, paginated=True),
    post=endpoint(
        "create_project_share", dto.ShareCreated, request=CreateShareBody, status=201
    ),
)
class ShareListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(visible_projects(actor(request)), id=project_id)
        project_role(project, actor(request), owner=True)
        offset, limit = page_values(request)
        query = project.shares.all()
        return Response(
            {
                "items": [
                    share_data(share) for share in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )

    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = CreateShareBody(data=request.data)
        body.is_valid(raise_exception=True)
        share, token = services.create_share(
            actor(request), project_id, **body.validated_data
        )
        return Response(
            {
                "share": share_data(share),
                "share_url": f"{settings.PUBLIC_APP_ORIGIN}/shares#{token}",
            },
            status=201,
        )


@extend_schema_view(delete=endpoint("revoke_project_share", status=204))
class ShareDetailView(APIView):
    def delete(
        self, request: Request, project_id: uuid.UUID, share_id: uuid.UUID
    ) -> Response:
        services.revoke_share(actor(request), project_id, share_id)
        return Response(status=204)


@extend_schema_view(
    post=endpoint(
        "resolve_source_share",
        PolymorphicProxySerializer(
            component_name="ResolvedShare",
            serializers={
                "live": dto.LiveShareResolved,
                "snapshot": dto.SnapshotShareResolved,
            },
            resource_type_field_name="kind",
        ),
        request=ResolveShareBody,
    )
)
class ShareResolveView(APIView):
    permission_classes = [AllowAny]

    def post(self, request: Request) -> Response:
        if request.headers.get("Origin", "") != settings.PUBLIC_APP_ORIGIN:
            return Response({"detail": "Shared source unavailable."}, status=403)
        body = ResolveShareBody(data=request.data)
        body.is_valid(raise_exception=True)
        user = request.user if isinstance(request.user, User) else None
        result = services.resolve_share(
            body.validated_data["token"], user, request._request.session.session_key
        )
        return Response(result, headers={"Cache-Control": "private, no-store"})

import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.collaboration.api import StrictIntegerField, StrictUUIDField
from code_along.common.api import BodySerializer, actor, page_values
from code_along.common.schema_helpers import endpoint
from code_along.common.schemas import ProjectOutput

from . import revision_dto as dto
from . import revision_services as services
from .api import VersionBody, project_data
from .models import ProjectRevision
from .policies import project_role, visible_projects


class CreateRevisionBody(VersionBody):
    expected_version = StrictIntegerField(min_value=1, max_value=9007199254740991)
    name = serializers.CharField(max_length=120)
    client_request_id = StrictUUIDField()


class CopyRevisionBody(BodySerializer):
    name = serializers.CharField(max_length=120)


def revision_data(revision: ProjectRevision) -> dict[str, Any]:
    return {
        "id": str(revision.id),
        "project_id": str(revision.project_id),
        "name": revision.name,
        "author": {
            "id": str(revision.author_id),
            "display_name": revision.author_display_name,
        },
        "created_at": revision.created_at,
        "metadata_version": revision.metadata_version,
        "manifest_sha256": revision.manifest_sha256,
        "provenance": revision.provenance,
    }


@extend_schema_view(
    get=endpoint("list_project_revisions", dto.RevisionPage, paginated=True),
    post=extend_schema(
        operation_id="create_project_revision",
        request=CreateRevisionBody,
        responses={
            200: dto.RevisionOutput,
            201: dto.RevisionOutput,
            403: None,
            409: None,
            429: None,
            503: None,
        },
    ),
)
class RevisionListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(visible_projects(actor(request)), id=project_id)
        project_role(project, actor(request))
        offset, limit = page_values(request)
        query = project.revisions.all()
        return Response(
            {
                "items": [
                    revision_data(revision)
                    for revision in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )

    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = CreateRevisionBody(data=request.data)
        body.is_valid(raise_exception=True)
        revision, created = services.create_revision(
            actor(request),
            request._request.session.session_key,
            project_id,
            **body.validated_data,
        )
        return Response(revision_data(revision), status=201 if created else 200)


@extend_schema_view(get=endpoint("get_project_revision", dto.RevisionDetail))
class RevisionDetailView(APIView):
    def get(
        self, request: Request, project_id: uuid.UUID, revision_id: uuid.UUID
    ) -> Response:
        revision = services.readable_revision(actor(request), project_id, revision_id)
        return Response(
            {
                **revision_data(revision),
                "manifest": services.revision_manifest(revision),
            }
        )


@extend_schema_view(
    post=endpoint(
        "copy_project_revision", ProjectOutput, request=CopyRevisionBody, status=201
    )
)
class RevisionCopyView(APIView):
    def post(
        self, request: Request, project_id: uuid.UUID, revision_id: uuid.UUID
    ) -> Response:
        body = CopyRevisionBody(data=request.data)
        body.is_valid(raise_exception=True)
        project = services.copy_revision(
            actor(request),
            request._request.session.session_key,
            project_id,
            revision_id,
            **body.validated_data,
        )
        return Response(project_data(project, "owner"), status=201)

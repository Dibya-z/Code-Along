import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import BodySerializer, actor, page_values
from code_along.workspaces.policies import visible_workspaces

from . import services
from .models import Project, ProjectAccess, ProjectFile, RuntimeProfile
from .policies import project_role, visible_projects


class CreateProjectBody(BodySerializer):
    name = serializers.CharField(max_length=120)
    runtime_profile_id = serializers.UUIDField(required=False)


class VersionBody(BodySerializer):
    expected_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)


class ProjectBody(VersionBody):
    name = serializers.CharField(max_length=120, required=False)
    archived = serializers.BooleanField(required=False)
    entrypoint_file_id = serializers.UUIDField(required=False)


class FileBody(VersionBody):
    path = serializers.CharField(max_length=160, trim_whitespace=False)
    initial_source = serializers.CharField(
        max_length=128 * 1024,
        trim_whitespace=False,
        allow_blank=True,
        required=False,
        default="",
    )


class RenameBody(VersionBody):
    path = serializers.CharField(max_length=160, trim_whitespace=False)


class GrantBody(BodySerializer):
    role = serializers.ChoiceField(choices=["editor", "viewer"])


class TransferBody(VersionBody):
    new_owner_id = serializers.UUIDField()


def file_data(file: ProjectFile, *, source: bool = False) -> dict[str, Any]:
    data = {
        "id": str(file.id),
        "document_id": str(file.document.id),
        "path": file.path,
        "kind": file.kind,
        "generation": file.generation,
        "initial_sha256": file.initial_sha256,
    }
    if source:
        data["initial_source"] = file.initial_source
    return data


def project_data(project: Project, role: str) -> dict[str, Any]:
    return {
        "id": str(project.id),
        "workspace_id": str(project.workspace_id),
        "owner_id": str(project.owner_id),
        "name": project.name,
        "role": role,
        "entrypoint_file_id": str(project.entrypoint_file_id),
        "entrypoint_path": project.entrypoint_file.path,
        "runtime_profile_id": str(project.runtime_profile_id),
        "runtime_id": project.runtime_profile.runtime_id,
        "metadata_version": project.metadata_version,
        "acl_version": str(project.acl_version),
        "archived": project.archived_at is not None,
    }


class ProjectListView(APIView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        get_object_or_404(visible_workspaces(actor(request)), id=workspace_id)
        offset, limit = page_values(request)
        query = (
            visible_projects(actor(request))
            .filter(workspace_id=workspace_id)
            .select_related("workspace", "entrypoint_file", "runtime_profile")
        )
        selected = list(query[offset : offset + limit])
        grants = dict(
            ProjectAccess.objects.filter(
                project__in=selected, user=actor(request)
            ).values_list("project_id", "role")
        )
        items = []
        for project in selected:
            role = (
                "owner"
                if project.owner_id == actor(request).id
                else grants.get(project.id)
            )
            if role:
                items.append(project_data(project, role))
        return Response({"items": items, "count": query.count()})

    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        body = CreateProjectBody(data=request.data)
        body.is_valid(raise_exception=True)
        project = services.create_project(
            actor(request), workspace_id, **body.validated_data
        )
        return Response(project_data(project, "owner"), status=201)


class ProjectDetailView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(
            visible_projects(actor(request)).select_related(
                "workspace", "runtime_profile", "entrypoint_file"
            ),
            id=project_id,
        )
        return Response(project_data(project, project_role(project, actor(request))))

    def patch(self, request: Request, project_id: uuid.UUID) -> Response:
        body = ProjectBody(data=request.data)
        body.is_valid(raise_exception=True)
        project = services.update_project(
            actor(request), project_id, **body.validated_data
        )
        return Response(project_data(project, project_role(project, actor(request))))


class FileListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(visible_projects(actor(request)), id=project_id)
        query = (
            project.files.filter(deleted_at__isnull=True)
            .select_related("document")
            .defer("initial_source")
        )
        return Response(
            {"items": [file_data(f) for f in query], "count": query.count()}
        )

    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = FileBody(data=request.data)
        body.is_valid(raise_exception=True)
        file = services.add_file(actor(request), project_id, **body.validated_data)
        return Response(file_data(file, source=True), status=201)


class FileDetailView(APIView):
    def get(
        self, request: Request, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> Response:
        project = get_object_or_404(visible_projects(actor(request)), id=project_id)
        return Response(
            file_data(services.file_for_project(project, file_id), source=True)
        )

    def patch(
        self, request: Request, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> Response:
        body = RenameBody(data=request.data)
        body.is_valid(raise_exception=True)
        file = services.rename_file(
            actor(request), project_id, file_id, **body.validated_data
        )
        return Response(file_data(file))

    def delete(
        self, request: Request, project_id: uuid.UUID, file_id: uuid.UUID
    ) -> Response:
        body = VersionBody(data=request.data)
        body.is_valid(raise_exception=True)
        services.delete_file(actor(request), project_id, file_id, **body.validated_data)
        return Response(status=204)


class GrantListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(
            visible_projects(actor(request)).select_related("workspace"), id=project_id
        )
        project_role(project, actor(request), owner=True)
        offset, limit = page_values(request)
        query = project.access_grants.select_related("user").order_by(
            "created_at", "id"
        )
        return Response(
            {
                "items": [
                    {
                        "user_id": str(g.user_id),
                        "display_name": g.user.display_name,
                        "role": g.role,
                    }
                    for g in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )


class GrantDetailView(APIView):
    def put(
        self, request: Request, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> Response:
        body = GrantBody(data=request.data)
        body.is_valid(raise_exception=True)
        services.set_grant(
            actor(request), project_id, user_id, body.validated_data["role"]
        )
        return Response(status=204)

    def delete(
        self, request: Request, project_id: uuid.UUID, user_id: uuid.UUID
    ) -> Response:
        services.revoke_grant(actor(request), project_id, user_id)
        return Response(status=204)


class ProjectOwnershipView(APIView):
    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = TransferBody(data=request.data)
        body.is_valid(raise_exception=True)
        project = services.transfer_project(
            actor(request), project_id, **body.validated_data
        )
        return Response(project_data(project, project_role(project, actor(request))))


class RuntimeListView(APIView):
    def get(self, request: Request) -> Response:
        return Response(
            {
                "items": [
                    {
                        "id": str(p.id),
                        "runtime_id": p.runtime_id,
                        "manifest_sha256": p.manifest_sha256,
                    }
                    for p in RuntimeProfile.objects.filter(enabled=True).order_by(
                        "runtime_id"
                    )
                ]
            }
        )

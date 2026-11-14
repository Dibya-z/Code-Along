import io
import uuid
from collections.abc import Mapping
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework.exceptions import ParseError
from rest_framework.parsers import JSONParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import actor, page_values
from code_along.common.schema_helpers import endpoint
from code_along.events.contracts import utc
from code_along.projects.revision_services import revision_manifest
from code_along.workspaces.models import Workspace

from . import contracts, dto, selectors, services
from .models import Assignment, AssignmentVersion
from .policies import is_teacher, require_assignment_teacher


class AssignmentJSONParser(JSONParser):
    def parse(
        self,
        stream: Any,
        media_type: str | None = None,
        parser_context: Mapping[str, Any] | None = None,
    ) -> Any:
        raw = stream.read(contracts.MAX_REQUEST_BYTES + 1)
        if len(raw) > contracts.MAX_REQUEST_BYTES:
            raise ParseError("Assignment requests must not exceed 256 KiB.")
        try:
            return super().parse(io.BytesIO(raw), media_type, parser_context)
        except RecursionError:
            raise ParseError(
                "Assignment JSON nesting exceeds the supported limit."
            ) from None


class AssignmentView(APIView):
    parser_classes = [AssignmentJSONParser]


def version_summary(version: AssignmentVersion) -> dict[str, Any]:
    return {
        "id": str(version.id),
        "number": version.number,
        "title": version.title,
        "published_at": utc(version.published_at),
        "content_sha256": version.content_sha256,
        "starter_manifest_sha256": version.starter_manifest_sha256,
        "submission_mode": version.submission_mode,
        "due_at": utc(version.due_at) if version.due_at else None,
        "max_attempts": version.max_attempts,
        "max_team_size": version.max_team_size,
    }


def summary_data(assignment: Assignment, teacher: bool) -> dict[str, Any]:
    current = assignment.current_version
    return {
        "id": str(assignment.id),
        "workspace_id": str(assignment.workspace_id),
        "title": assignment.draft_title
        if teacher
        else current.title
        if current
        else "",
        "archived": assignment.archived_at is not None,
        "published": current is not None,
        "current_version": version_summary(current) if current else None,
        "can_author": teacher,
    }


def draft_data(assignment: Assignment) -> dict[str, Any]:
    origin: dict[str, Any] | None = None
    if assignment.draft_starter_revision_id is not None:
        prior = services.prior_starter(assignment, assignment.draft_starter_revision_id)
        origin = (
            {
                "kind": "published_assignment",
                "assignment_version_id": str(prior.id),
                "number": prior.number,
            }
            if prior
            else {"kind": "owned_project"}
        )
    return {
        "assignment_id": str(assignment.id),
        "revision": assignment.revision,
        "title": assignment.draft_title,
        "instructions": assignment.draft_instructions,
        "hints": assignment.draft_hints,
        "public_checks_source": assignment.draft_public_checks_source,
        "starter_project_id": str(assignment.draft_starter_project_id)
        if assignment.draft_starter_project_id
        else None,
        "starter_revision_id": str(assignment.draft_starter_revision_id)
        if assignment.draft_starter_revision_id
        else None,
        "starter_origin": origin,
        "submission_mode": assignment.draft_submission_mode,
        "max_attempts": assignment.draft_max_attempts,
        "max_team_size": assignment.draft_max_team_size,
        "due_at": utc(assignment.draft_due_at) if assignment.draft_due_at else None,
    }


def version_data(version: AssignmentVersion) -> dict[str, Any]:
    return {
        "id": str(version.id),
        "assignment_id": str(version.assignment_id),
        "workspace_id": str(version.workspace_id),
        "number": version.number,
        "title": version.title,
        "instructions": version.instructions,
        "hints": version.hints,
        "published_at": utc(version.published_at),
        "publisher": {
            "id": str(version.published_by_id),
            "display_name": version.author_display_name,
        },
        "starter": {
            "revision_id": str(version.starter_revision_id),
            "manifest_sha256": version.starter_manifest_sha256,
        },
        "runtime": version.runtime_identity,
        "helper_release": version.helper_release,
        "public_checks": version.public_checks,
        "submission_policy": {
            "mode": version.submission_mode,
            "max_attempts": version.max_attempts,
            "max_team_size": version.max_team_size,
            "due_at": utc(version.due_at) if version.due_at else None,
            "late_policy": version.late_policy,
        },
        "content_sha256": version.content_sha256,
    }


@extend_schema_view(
    get=extend_schema(
        operation_id="list_assignments",
        parameters=[dto.AssignmentListQuery],
        responses={200: dto.AssignmentPage},
    ),
    post=endpoint(
        "create_assignment",
        dto.AssignmentSummary,
        request=dto.AssignmentCreate,
        status=201,
    ),
)
class AssignmentListView(AssignmentView):
    def get(self, request: Request, workspace_id: uuid.UUID) -> Response:
        workspace = get_object_or_404(Workspace, id=workspace_id)
        teacher = is_teacher(workspace, actor(request))
        query = dto.AssignmentListQuery(data=request.query_params.dict())
        query.is_valid(raise_exception=True)
        values = query.validated_data
        assignments = selectors.visible_assignments(workspace, actor(request))
        if values["include_archived"] == "false":
            assignments = assignments.filter(archived_at__isnull=True)
        return Response(
            {
                "items": [
                    summary_data(item, teacher)
                    for item in assignments[
                        values["offset"] : values["offset"] + values["limit"]
                    ]
                ],
                "count": assignments.count(),
            }
        )

    def post(self, request: Request, workspace_id: uuid.UUID) -> Response:
        body = dto.AssignmentCreate(data=request.data)
        body.is_valid(raise_exception=True)
        assignment = services.create_assignment(
            actor(request),
            request._request.session.session_key,
            workspace_id,
            **body.validated_data,
        )
        return Response(summary_data(assignment, True), status=201)


@extend_schema_view(
    get=endpoint("get_assignment", dto.AssignmentSummary),
    patch=endpoint(
        "archive_assignment", dto.AssignmentSummary, request=dto.AssignmentArchive
    ),
)
class AssignmentDetailView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        assignment = selectors.readable_assignment(assignment_id, actor(request))
        return Response(
            summary_data(assignment, is_teacher(assignment.workspace, actor(request)))
        )

    def patch(self, request: Request, assignment_id: uuid.UUID) -> Response:
        body = dto.AssignmentArchive(data=request.data)
        body.is_valid(raise_exception=True)
        assignment = services.archive_assignment(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **body.validated_data,
        )
        return Response(summary_data(assignment, True))


@extend_schema_view(
    get=endpoint("get_assignment_draft", dto.AssignmentDraft),
    patch=endpoint(
        "update_assignment_draft", dto.AssignmentDraft, request=dto.AssignmentDraftPatch
    ),
)
class AssignmentDraftView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        assignment = selectors.readable_assignment(assignment_id, actor(request))
        require_assignment_teacher(assignment.workspace, actor(request))
        return Response(draft_data(assignment))

    def patch(self, request: Request, assignment_id: uuid.UUID) -> Response:
        body = dto.AssignmentDraftPatch(data=request.data)
        body.is_valid(raise_exception=True)
        assignment = services.update_draft(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **body.validated_data,
        )
        return Response(draft_data(assignment))


@extend_schema_view(
    get=endpoint("list_assignment_versions", dto.AssignmentVersionPage, paginated=True),
    post=extend_schema(
        operation_id="publish_assignment_version",
        request=dto.AssignmentPublish,
        responses={
            200: dto.AssignmentVersionDetail,
            201: dto.AssignmentVersionDetail,
            400: None,
            403: None,
            404: None,
            409: None,
            429: None,
        },
    ),
)
class AssignmentVersionListView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        assignment = selectors.readable_assignment(assignment_id, actor(request))
        offset, limit = page_values(request)
        query = assignment.versions.all()
        return Response(
            {
                "items": [
                    version_summary(item) for item in query[offset : offset + limit]
                ],
                "count": query.count(),
            }
        )

    def post(self, request: Request, assignment_id: uuid.UUID) -> Response:
        body = dto.AssignmentPublish(data=request.data)
        body.is_valid(raise_exception=True)
        version, created = services.publish_version(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **body.validated_data,
        )
        return Response(version_data(version), status=201 if created else 200)


@extend_schema_view(get=endpoint("get_assignment_version", dto.AssignmentVersionDetail))
class AssignmentVersionDetailView(AssignmentView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, version_id: uuid.UUID
    ) -> Response:
        assignment = selectors.readable_assignment(assignment_id, actor(request))
        return Response(
            version_data(selectors.read_assignment_version(assignment, version_id))
        )


@extend_schema_view(get=endpoint("get_assignment_starter", dto.AssignmentStarter))
class AssignmentStarterView(AssignmentView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, version_id: uuid.UUID
    ) -> Response:
        assignment = selectors.readable_assignment(assignment_id, actor(request))
        version = selectors.read_assignment_version(assignment, version_id)
        return Response(
            {
                "assignment_id": str(assignment.id),
                "assignment_version_id": str(version.id),
                "revision_id": str(version.starter_revision_id),
                "manifest": revision_manifest(version.starter_revision),
            }
        )

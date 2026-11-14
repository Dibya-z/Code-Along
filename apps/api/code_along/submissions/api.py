import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework.exceptions import NotFound, UnsupportedMediaType
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import PageSerializer, actor
from code_along.common.schema_helpers import PAGE_PARAMETERS, endpoint
from code_along.events.contracts import utc
from code_along.learning.models import AssignmentWork
from code_along.learning.participation_api import assignment_scope, values
from code_along.learning.participation_services import current_member
from code_along.learning.policies import is_teacher
from code_along.learning.work_services import subject_members
from code_along.projects.models import Project
from code_along.projects.revision_services import revision_manifest

from . import dto
from .manifest import validate_submission_manifest
from .models import Submission
from .parsers import SubmissionJSONParser
from .policies import new_submit_reason
from .selectors import authorized_rows, readable_submission
from .services import prepare, submit


class SubmissionView(APIView):
    parser_classes = [SubmissionJSONParser]


def summary_data(record: Submission, request: Request) -> dict[str, Any]:
    participants = list(record.participants.all())
    return {
        "id": str(record.id),
        "assignment_id": str(record.assignment_id),
        "work_id": str(record.work_id),
        "assignment_version_id": str(record.assignment_version_id),
        "assignment_submission_number": record.assignment_submission_number,
        "submitted_at": utc(record.submitted_at),
        "author": {
            "id": str(record.author_id),
            "display_name": record.author_display_name,
        },
        "participants": [
            {"id": str(p.user_id), "display_name": p.display_name} for p in participants
        ],
        "client_request_id": str(record.client_request_id),
        "source_manifest_sha256": record.source_manifest_sha256,
        "artifact_manifest_sha256": record.revision.manifest_sha256,
        "artifact_scope": "submission",
        "provenance": "client_submitted_snapshot",
        "practice": record.practice,
        "can_review": record.assignment.archived_at is None
        and record.assignment.workspace.archived_at is None
        and is_teacher(record.assignment.workspace, actor(request))
        and all(p.user_id != actor(request).id for p in participants),
    }


def detail_data(record: Submission, request: Request) -> dict[str, Any]:
    frozen = revision_manifest(record.revision)
    manifest = validate_submission_manifest(
        {
            "version": 2,
            "project_id": frozen["project_id"],
            "source_kind": "project",
            "metadata_version": frozen["metadata_version"],
            "entrypoint_file_id": frozen["entrypoint_file_id"],
            "runtime": frozen["runtime"],
            "stdin_mode": record.stdin_mode,
            "files": frozen["files"],
            "sha256": record.source_manifest_sha256,
        }
    ).as_manifest()
    version = record.assignment_version
    return {
        **summary_data(record, request),
        "manifest": manifest,
        "helper_release": record.revision.helper_release,
        "published_version": {
            "number": version.number,
            "title": version.title,
            "content_sha256": version.content_sha256,
            "submission_mode": version.submission_mode,
        },
    }


@extend_schema_view(
    get=endpoint("list_work_submissions", dto.WorkSubmissionPage, paginated=True),
    post=extend_schema(
        operation_id="create_submission",
        request=dto.SubmissionCreate,
        responses={
            201: dto.SubmissionDetail,
            200: dto.SubmissionDetail,
            400: None,
            403: None,
            404: None,
            409: None,
            413: None,
            429: None,
        },
    ),
)
class WorkSubmissionsView(SubmissionView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, work_id: uuid.UUID
    ) -> Response:
        assignment = assignment_scope(assignment_id, actor(request))
        current_member(actor(request), request.session.session_key, assignment)
        work = get_object_or_404(
            AssignmentWork.objects.select_related(
                "assignment_version", "participation", "team"
            ),
            assignment=assignment,
            id=work_id,
        )
        work.assignment, work.workspace = assignment, assignment.workspace
        params = values(request, PageSerializer, query=True)
        rows = authorized_rows(assignment, actor(request)).filter(work=work)
        teacher = is_teacher(assignment.workspace, actor(request))
        eligible = any(
            member.user_id == actor(request).id for member in subject_members(work)
        )
        if not teacher and not eligible and not rows.exists():
            raise NotFound("Submission history unavailable.")
        # A nonparticipant teacher sees private history, not source conditions.
        project = (
            Project.objects.select_related("runtime_profile")
            .filter(id=work.project_id)
            .first()
            if eligible
            else None
        )
        now = timezone.now()
        reason = (
            new_submit_reason(work, actor(request), project, now)
            if eligible
            else "submission_participation_unavailable"
        )
        page = rows.select_related(
            "revision", "assignment", "assignment__workspace"
        ).prefetch_related("participants")[
            params["offset"] : params["offset"] + params["limit"]
        ]
        result = {
            "items": [summary_data(record, request) for record in page],
            "count": rows.count(),
            "availability": {
                "can_submit": reason is None,
                "reason": reason,
                "checked_at": utc(now),
            },
        }
        current_member(
            actor(request), request.session.session_key, assignment, teacher=teacher
        )
        return Response(result)

    def post(
        self, request: Request, assignment_id: uuid.UUID, work_id: uuid.UUID
    ) -> Response:
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        # Do not use request.data's Content-Length-derived empty-stream shortcut.
        # Reading the underlying actual request remains hard bounded, including
        # absent/incorrect length headers; no request.body allocation is used.
        body = SubmissionJSONParser().parse(
            request._request,
            parser_context={
                "request": request,
                "encoding": (request._request.content_params or {}).get(
                    "charset", "utf-8"
                ),
            },
        )
        prepared = prepare(body, work_id)
        record, created = submit(
            actor(request),
            request.session.session_key,
            assignment_id,
            work_id,
            prepared,
        )
        record.assignment.workspace = record.workspace
        result = detail_data(record, request)
        current_member(actor(request), request.session.session_key, record.assignment)
        return Response(result, status=201 if created else 200)


@extend_schema_view(
    get=extend_schema(
        operation_id="list_assignment_submissions",
        responses={200: dto.SubmissionPage},
        parameters=[
            *PAGE_PARAMETERS,
            OpenApiParameter("assignment_version_id", type=uuid.UUID),
        ],
    )
)
class AssignmentSubmissionsView(SubmissionView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        assignment = assignment_scope(assignment_id, actor(request))
        current_member(
            actor(request), request.session.session_key, assignment, teacher=True
        )
        params = values(request, dto.SubmissionListQuery, query=True)
        rows = authorized_rows(assignment, actor(request))
        if "assignment_version_id" in params:
            rows = rows.filter(assignment_version_id=params["assignment_version_id"])
        page = rows.select_related(
            "revision", "assignment", "assignment__workspace"
        ).prefetch_related("participants")[
            params["offset"] : params["offset"] + params["limit"]
        ]
        result = {
            "items": [summary_data(record, request) for record in page],
            "count": rows.count(),
        }
        current_member(
            actor(request), request.session.session_key, assignment, teacher=True
        )
        return Response(result)


@extend_schema_view(get=endpoint("get_submission", dto.SubmissionDetail))
class SubmissionDetailView(SubmissionView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        assignment = assignment_scope(assignment_id, actor(request))
        current_member(actor(request), request.session.session_key, assignment)
        record = readable_submission(assignment, submission_id, actor(request))
        record.assignment = assignment
        result = detail_data(record, request)
        current = current_member(
            actor(request), request.session.session_key, assignment
        )
        readable_submission(assignment, submission_id, current)
        return Response(result)

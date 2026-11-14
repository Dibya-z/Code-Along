import uuid
from typing import Any, cast

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework.exceptions import UnsupportedMediaType, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.collaboration.profiles import public_display_name
from code_along.common.api import BodySerializer, PageSerializer, actor
from code_along.common.schema_helpers import endpoint
from code_along.events.contracts import utc
from code_along.learning.models import Assignment
from code_along.learning.participation_api import values
from code_along.learning.participation_services import current_member

from . import feedback_dto as dto
from . import feedback_services as services
from .feedback_contracts import FeedbackJSONParser, feedback_error
from .feedback_policies import require_reviewer
from .models import FeedbackPublication, InstructorFeedback, Submission
from .selectors import authorized_rows


class FeedbackView(APIView):
    parser_classes = [FeedbackJSONParser]


def assignment_scope(request: Request, assignment_id: uuid.UUID) -> Assignment:
    assignment = get_object_or_404(
        Assignment.objects.select_related("workspace"), id=assignment_id
    )
    current_member(actor(request), request.session.session_key, assignment)
    return assignment


def command(request: Request, serializer: type[BodySerializer]) -> dict[str, Any]:
    if request.content_type != "application/json":
        raise UnsupportedMediaType(request.content_type)
    body = FeedbackJSONParser().parse(
        request._request,
        parser_context={
            "encoding": (request._request.content_params or {}).get("charset", "utf-8")
        },
    )
    parsed = serializer(data=body)
    try:
        parsed.is_valid(raise_exception=True)
    except ValidationError:
        raise feedback_error(
            "invalid_feedback_request",
            "Use the exact supported feedback command fields.",
            status=400,
        ) from None
    return cast(dict[str, Any], parsed.validated_data)


def published_scope(
    request: Request, assignment: Assignment, submission_id: uuid.UUID
) -> Submission:
    current = current_member(actor(request), request.session.session_key, assignment)
    return get_object_or_404(authorized_rows(assignment, current), id=submission_id)


def draft_data(
    submission_id: uuid.UUID, draft: InstructorFeedback | None
) -> dict[str, Any]:
    return {
        "submission_id": str(submission_id),
        "revision": draft.revision if draft else 0,
        "comments": draft.draft_comments if draft else "",
        "assessment_status": draft.draft_assessment_status if draft else None,
        "last_edited_by": {
            "id": str(draft.last_edited_by_id),
            "display_name": public_display_name(draft.last_edited_by.display_name),
        }
        if draft
        else None,
        "updated_at": utc(draft.updated_at) if draft else None,
    }


def publication_data(record: FeedbackPublication) -> dict[str, Any]:
    return {
        "id": str(record.id),
        "submission_id": str(record.submission_id),
        "assignment_id": str(record.assignment_id),
        "assignment_version_id": str(record.submission.assignment_version_id),
        "number": record.number,
        "comments": record.comments,
        "assessment_status": record.assessment_status,
        "publisher": {
            "id": str(record.published_by_id),
            "display_name": record.publisher_display_name,
        },
        "published_at": utc(record.published_at),
        "content_sha256": record.content_sha256,
        "assessment_kind": "manual",
    }


@extend_schema_view(get=endpoint("get_submission_feedback", dto.FeedbackLatest))
class FeedbackLatestView(FeedbackView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        assignment = assignment_scope(request, assignment_id)
        submission = published_scope(request, assignment, submission_id)
        latest = (
            FeedbackPublication.objects.filter(submission=submission)
            .select_related("submission")
            .first()
        )
        result = {"latest": publication_data(latest) if latest else None}
        published_scope(request, assignment, submission_id)
        return Response(result)


@extend_schema_view(
    get=endpoint("get_submission_feedback_draft", dto.FeedbackDraft),
    patch=endpoint(
        "save_submission_feedback_draft",
        dto.FeedbackDraft,
        request=dto.FeedbackDraftSave,
    ),
)
class FeedbackDraftView(FeedbackView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        assignment = assignment_scope(request, assignment_id)
        require_reviewer(
            assignment,
            submission_id,
            actor(request),
            request.session.session_key,
            open_parents=True,
        )
        draft = (
            InstructorFeedback.objects.filter(submission_id=submission_id)
            .select_related("last_edited_by")
            .first()
        )
        result = draft_data(submission_id, draft)
        require_reviewer(
            assignment,
            submission_id,
            actor(request),
            request.session.session_key,
            open_parents=True,
        )
        return Response(result)

    def patch(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        draft = services.save_draft(
            actor(request),
            request.session.session_key,
            assignment_id,
            submission_id,
            **command(request, dto.FeedbackDraftSave),
        )
        result = draft_data(submission_id, draft)
        assignment = assignment_scope(request, assignment_id)
        require_reviewer(
            assignment,
            submission_id,
            actor(request),
            request.session.session_key,
            open_parents=True,
        )
        return Response(result)


@extend_schema_view(
    get=endpoint("list_feedback_publications", dto.FeedbackPage, paginated=True),
    post=extend_schema(
        operation_id="publish_submission_feedback",
        request=dto.FeedbackPublish,
        responses={
            201: dto.FeedbackPublication,
            200: dto.FeedbackPublication,
            400: None,
            403: None,
            404: None,
            409: None,
            413: None,
            429: None,
        },
    ),
)
class FeedbackPublicationsView(FeedbackView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        assignment = assignment_scope(request, assignment_id)
        submission = published_scope(request, assignment, submission_id)
        params = values(request, PageSerializer, query=True)
        rows = FeedbackPublication.objects.filter(submission=submission)
        page = rows.select_related("submission")[
            params["offset"] : params["offset"] + params["limit"]
        ]
        result = {
            "items": [publication_data(record) for record in page],
            "count": rows.count(),
        }
        published_scope(request, assignment, submission_id)
        return Response(result)

    def post(
        self, request: Request, assignment_id: uuid.UUID, submission_id: uuid.UUID
    ) -> Response:
        record, created = services.publish_feedback(
            actor(request),
            request.session.session_key,
            assignment_id,
            submission_id,
            **command(request, dto.FeedbackPublish),
        )
        result = publication_data(record)
        assignment = assignment_scope(request, assignment_id)
        require_reviewer(
            assignment,
            submission_id,
            actor(request),
            request.session.session_key,
            open_parents=False,
        )
        return Response(result, status=201 if created else 200)

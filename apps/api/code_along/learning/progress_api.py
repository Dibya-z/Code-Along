import uuid

from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import actor
from code_along.common.schema_helpers import PAGE_PARAMETERS

from . import progress
from . import progress_dto as dto
from .participation_api import values

VERSION = OpenApiParameter("assignment_version_id", type=uuid.UUID, required=True)


@extend_schema_view(
    get=extend_schema(
        operation_id="get_own_learning_progress",
        parameters=[VERSION],
        responses={200: dto.OwnProgress},
    )
)
class OwnProgressView(APIView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        return Response(
            progress.own_progress(
                actor(request),
                request.session.session_key,
                assignment_id,
                **values(request, dto.ProgressQuery, query=True),
            )
        )


@extend_schema_view(
    get=extend_schema(
        operation_id="list_learner_progress",
        parameters=[VERSION, *PAGE_PARAMETERS],
        responses={200: dto.LearnerProgressPage},
    )
)
class LearnerProgressView(APIView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        return Response(
            progress.teacher_progress(
                actor(request),
                request.session.session_key,
                assignment_id,
                **values(request, dto.LearnerProgressQuery, query=True),
            )
        )

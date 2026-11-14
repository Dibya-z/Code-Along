import uuid
from typing import cast

from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import serializers
from rest_framework.exceptions import APIException, NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import BodySerializer, actor

from .notification_access import read_learning_head
from .notification_types import Audience, LearningDenied, LearningUnavailable
from .participation_api import values


class LearningHeadQuery(BodySerializer):
    audience = serializers.ChoiceField(choices=["teaching", "participant"])


class LearningHeadOutput(BodySerializer):
    protocol = serializers.ChoiceField(choices=["code-along.learning-events"])
    version = serializers.IntegerField(min_value=1, max_value=1)
    scope = serializers.ChoiceField(choices=["assignment"])
    assignment_id = serializers.UUIDField()
    audience = serializers.ChoiceField(choices=["teaching", "participant"])
    head_generation = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$")


class HeadUnavailable(APIException):
    status_code = 503
    default_detail = "The learning head is temporarily unavailable."


@extend_schema_view(
    get=extend_schema(
        operation_id="get_learning_head",
        parameters=[
            OpenApiParameter(
                "audience", type=str, enum=["teaching", "participant"], required=True
            )
        ],
        responses={200: LearningHeadOutput},
    )
)
class LearningHeadView(APIView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        audience = cast(
            Audience, values(request, LearningHeadQuery, query=True)["audience"]
        )
        try:
            head = read_learning_head(
                request.session.session_key,
                assignment_id,
                audience,
                expected_user_id=actor(request).id,
            )
        except LearningDenied:
            raise NotFound("Learning head unavailable.") from None
        except LearningUnavailable:
            raise HeadUnavailable() from None
        return Response(
            {
                "protocol": "code-along.learning-events",
                "version": 1,
                "scope": "assignment",
                "assignment_id": str(assignment_id),
                "audience": audience,
                "head_generation": str(head.generation),
            }
        )

import uuid

from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.collaboration.api import StrictUUIDField
from code_along.common.api import BodySerializer, actor
from code_along.events.contracts import sequence
from code_along.projects.revision_dto import RevisionAuthor

from . import services


class ChatMessageOutput(BodySerializer):
    id = serializers.UUIDField()
    project_id = serializers.UUIDField()
    client_message_id = serializers.UUIDField()
    sequence = serializers.RegexField(r"^[1-9][0-9]{0,18}$")
    author = RevisionAuthor()
    body = serializers.CharField(
        allow_null=True, allow_blank=True, trim_whitespace=False
    )
    created_at = serializers.DateTimeField()
    deleted = serializers.BooleanField()


class ChatPage(BodySerializer):
    items = ChatMessageOutput(many=True)
    next_after = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$")
    next_before = serializers.RegexField(r"^[1-9][0-9]{0,18}$", allow_null=True)
    has_more = serializers.BooleanField()
    head_sequence = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$")


class MessageBody(BodySerializer):
    client_message_id = StrictUUIDField()
    body = serializers.CharField(max_length=4096, trim_whitespace=False)

    def validate_body(self, value: str) -> str:
        if not isinstance(self.initial_data.get("body"), str):
            raise ValidationError("Use chat text.")
        services.body_bytes(value)
        return value


class HistoryQuery(BodySerializer):
    after = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$", required=False)
    before = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$", required=False)
    limit = serializers.IntegerField(min_value=1, max_value=100, default=50)


@extend_schema_view(
    get=extend_schema(
        operation_id="list_chat_messages",
        parameters=[HistoryQuery],
        responses={200: ChatPage},
    ),
    post=extend_schema(
        operation_id="create_chat_message",
        request=MessageBody,
        responses={
            200: ChatMessageOutput,
            201: ChatMessageOutput,
            400: None,
            403: None,
            404: None,
            409: None,
            429: None,
        },
    ),
)
class MessageListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        query = HistoryQuery(data=request.query_params.dict())
        query.is_valid(raise_exception=True)
        fields = query.validated_data
        if "after" in fields and "before" in fields:
            raise ValidationError({"detail": "Choose after or before, not both."})
        try:
            after = sequence(fields["after"]) if "after" in fields else None
            before = sequence(fields["before"]) if "before" in fields else None
        except ValueError:
            raise ValidationError({"detail": "Use a supported chat cursor."}) from None
        return Response(
            services.history(
                actor(request),
                project_id,
                after=after,
                before=before,
                limit=fields["limit"],
            )
        )

    def post(self, request: Request, project_id: uuid.UUID) -> Response:
        body = MessageBody(data=request.data)
        body.is_valid(raise_exception=True)
        message, created = services.send_message(
            actor(request),
            request._request.session.session_key,
            project_id,
            **body.validated_data,
        )
        return Response(services.message_data(message), status=201 if created else 200)

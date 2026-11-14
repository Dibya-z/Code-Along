import uuid
from typing import Any

from django.shortcuts import get_object_or_404
from drf_spectacular.utils import (
    PolymorphicProxySerializer,
    extend_schema,
    extend_schema_field,
    extend_schema_view,
)
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.chat.api import ChatMessageOutput
from code_along.common.api import BodySerializer, actor
from code_along.projects.policies import project_role, visible_projects

from .contracts import sequence
from .services import replay


class MetadataData(BodySerializer):
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)


class AccessData(BodySerializer):
    project_acl_version = serializers.RegexField(r"^[1-9][0-9]{0,18}$")
    workspace_acl_version = serializers.RegexField(r"^[1-9][0-9]{0,18}$")


class RevisionData(BodySerializer):
    revision_id = serializers.UUIDField()


class ChatData(BodySerializer):
    message = ChatMessageOutput()


class EventEnvelope(BodySerializer):
    protocol = serializers.RegexField(r"^code-along\.events$")
    version = serializers.IntegerField(min_value=1, max_value=1)
    type = serializers.ChoiceField(choices=["event"])
    id = serializers.UUIDField()
    project_id = serializers.UUIDField()
    sequence = serializers.RegexField(r"^[1-9][0-9]{0,18}$")
    occurred_at = serializers.DateTimeField()


class MetadataEvent(EventEnvelope):
    event_type = serializers.ChoiceField(choices=["project.changed"])
    data = MetadataData()  # type: ignore[assignment]  # Wire key overlaps Serializer.data.


class AccessEvent(EventEnvelope):
    event_type = serializers.ChoiceField(choices=["project.access.changed"])
    data = AccessData()  # type: ignore[assignment]


class RevisionEvent(EventEnvelope):
    event_type = serializers.ChoiceField(choices=["revision.created"])
    data = RevisionData()  # type: ignore[assignment]


class ChatEvent(EventEnvelope):
    event_type = serializers.ChoiceField(choices=["chat.message.created"])
    data = ChatData()  # type: ignore[assignment]


EVENT_SERIALIZERS: dict[str, type[serializers.Serializer[Any]]] = {
    "project.changed": MetadataEvent,
    "project.access.changed": AccessEvent,
    "revision.created": RevisionEvent,
    "chat.message.created": ChatEvent,
}
SCHEMA_SERIALIZERS: dict[
    str, serializers.Serializer[Any] | type[serializers.Serializer[Any]]
] = dict(EVENT_SERIALIZERS)


@extend_schema_field(
    PolymorphicProxySerializer(
        component_name="ProjectEvent",
        serializers=SCHEMA_SERIALIZERS,
        resource_type_field_name="event_type",
    )
)
class ProjectEventField(serializers.Field[Any, Any, Any, Any]):
    def to_internal_value(self, data: Any) -> Any:
        serializer_type = (
            EVENT_SERIALIZERS.get(data["event_type"])
            if isinstance(data, dict) and isinstance(data.get("event_type"), str)
            else None
        )
        if serializer_type is None:
            raise ValidationError("Use a supported project event.")
        serializer = serializer_type(data=data)
        serializer.is_valid(raise_exception=True)
        return serializer.validated_data

    def to_representation(self, value: Any) -> Any:
        return value


class EventPage(BodySerializer):
    items = serializers.ListField(child=ProjectEventField())
    head_sequence = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$")
    next_after = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$")
    refresh_required = serializers.BooleanField()


class EventQuery(BodySerializer):
    after = serializers.RegexField(r"^(0|[1-9][0-9]{0,18})$", default="0")
    limit = serializers.IntegerField(min_value=1, max_value=100, default=50)


@extend_schema_view(
    get=extend_schema(
        operation_id="list_project_events",
        parameters=[EventQuery],
        responses={200: EventPage},
    )
)
class ProjectEventListView(APIView):
    def get(self, request: Request, project_id: uuid.UUID) -> Response:
        project = get_object_or_404(visible_projects(actor(request)), id=project_id)
        project_role(project, actor(request))
        query = EventQuery(data=request.query_params.dict())
        query.is_valid(raise_exception=True)
        try:
            after = sequence(query.validated_data["after"])
        except ValueError:
            raise ValidationError(
                {"after": "Use a supported project event cursor."}
            ) from None
        return Response(replay(project, after, limit=query.validated_data["limit"]))

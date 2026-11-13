import re
import secrets
import uuid
from typing import Any

from django.conf import settings
from django.db import DatabaseError
from drf_spectacular.utils import extend_schema_view
from rest_framework import serializers
from rest_framework.exceptions import ParseError, UnsupportedMediaType, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common.api import BodySerializer, actor
from code_along.common.schema_helpers import endpoint

from . import services


class StrictIntegerField(serializers.IntegerField):
    def to_internal_value(self, data: Any) -> int:
        if type(data) is not int:
            raise ValidationError("Use an integer.")
        return super().to_internal_value(data)


class StrictUUIDField(serializers.UUIDField):
    def to_internal_value(self, data: Any) -> uuid.UUID:
        if not isinstance(data, str) or not re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            data,
        ):
            raise ValidationError("Use a canonical UUID.")
        return super().to_internal_value(data)


class TicketBody(BodySerializer):
    generation = StrictIntegerField(min_value=1, max_value=2147483647)
    scope = serializers.ChoiceField(choices=["read", "write"])
    client_session_id = StrictUUIDField()
    awareness_client_id = StrictIntegerField(min_value=0, max_value=4294967295)
    share_token = serializers.RegexField(
        r"^[A-Za-z0-9_-]{43}$", trim_whitespace=False, required=False
    )


class TicketOutput(BodySerializer):
    ticket = serializers.CharField(min_length=43, max_length=43)
    expires_at = serializers.DateTimeField()
    document_name = serializers.CharField(max_length=48)


@extend_schema_view(
    post=endpoint(
        "create_collaboration_ticket", TicketOutput, request=TicketBody, status=201
    )
)
class TicketView(APIView):
    def post(
        self, request: Request, project_id: uuid.UUID, document_id: uuid.UUID
    ) -> Response:
        body = TicketBody(data=request.data)
        body.is_valid(raise_exception=True)
        try:
            result = services.issue_ticket(
                actor(request),
                request._request.session.session_key,
                request.headers.get("Origin", ""),
                project_id,
                document_id,
                **body.validated_data,
            )
        except services.AdmissionError as error:
            return Response(
                {"detail": "Collaboration unavailable. Refresh access and try again."},
                status=error.status,
            )
        return Response(
            result, status=201, headers={"Cache-Control": "private, no-store"}
        )


class ConsumeBody(BodySerializer):
    version = StrictIntegerField(min_value=1, max_value=1)
    ticket = serializers.RegexField(r"^[A-Za-z0-9_-]{43}$", trim_whitespace=False)
    document_name = serializers.RegexField(
        r"^[0-9a-f-]{36}:[1-9][0-9]{0,9}$", trim_whitespace=False
    )
    connection_id = StrictUUIDField()
    transport_id = StrictUUIDField()
    origin = serializers.CharField(max_length=255, trim_whitespace=False)


class RenewBody(BodySerializer):
    version = StrictIntegerField(min_value=1, max_value=1)
    lease_id = StrictUUIDField()
    lease_token = serializers.RegexField(r"^[A-Za-z0-9_-]{43}$", trim_whitespace=False)
    connection_id = StrictUUIDField()
    document_name = serializers.RegexField(
        r"^[0-9a-f-]{36}:[1-9][0-9]{0,9}$", trim_whitespace=False
    )


class PrivateAdmissionView(APIView):
    authentication_classes: list[type] = []
    permission_classes: list[type] = []
    throttle_classes: list[type] = []
    schema = None
    renew = False

    def post(self, request: Request) -> Response:
        secret = settings.COLLABORATION_SECRET
        supplied = request.headers.get("Authorization", "")
        if (
            not secret
            or not supplied.isascii()
            or not secrets.compare_digest(
                supplied.encode(), f"Bearer {secret}".encode()
            )
        ):
            return self.failure("unauthorized", 403)
        try:
            body = (
                RenewBody(data=request.data)
                if self.renew
                else ConsumeBody(data=request.data)
            )
            if not body.is_valid():
                return self.failure("unauthorized", 403)
            values = dict(body.validated_data)
            values.pop("version")
            if self.renew:
                result = services.renew_lease(**values)
            else:
                result = services.consume_ticket(
                    request.COOKIES.get(settings.SESSION_COOKIE_NAME), **values
                )
        except services.AdmissionError as error:
            return self.failure(error.code, error.status)
        except (ParseError, UnsupportedMediaType):
            return self.failure("unauthorized", 403)
        except DatabaseError:
            return self.failure("unavailable", 503)
        return Response(result, headers={"Cache-Control": "private, no-store"})

    @staticmethod
    def failure(code: str, status: int) -> Response:
        return Response(
            {"version": 1, "error": code},
            status=status,
            headers={"Cache-Control": "private, no-store"},
        )


class RenewView(PrivateAdmissionView):
    renew = True

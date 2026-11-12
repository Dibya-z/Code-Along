from typing import Any, cast

from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.request import Request

from code_along.accounts.models import User


class BodySerializer(serializers.Serializer[dict[str, Any]]):
    def to_internal_value(self, data: Any) -> dict[str, Any]:
        if isinstance(data, dict) and set(data) - set(self.fields):
            raise ValidationError({"detail": "Unexpected request fields."})
        return cast(dict[str, Any], super().to_internal_value(data))


def actor(request: Request) -> User:
    user = request.user
    assert isinstance(user, User)
    return user


class PageSerializer(BodySerializer):
    offset = serializers.IntegerField(min_value=0, max_value=100000, default=0)
    limit = serializers.IntegerField(min_value=1, max_value=100, default=50)


def page_values(request: Request) -> tuple[int, int]:
    value = PageSerializer(data=request.query_params.dict())
    value.is_valid(raise_exception=True)
    return int(value.validated_data["offset"]), int(value.validated_data["limit"])

from typing import Any

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema

from .schemas import ErrorOutput

PAGE_PARAMETERS = [
    OpenApiParameter(
        "limit", type={"type": "integer", "minimum": 1, "maximum": 100, "default": 50}
    ),
    OpenApiParameter(
        "offset",
        type={"type": "integer", "minimum": 0, "maximum": 100000, "default": 0},
    ),
]
VERSION_PARAMETER = OpenApiParameter(
    "expected_version",
    type={"type": "integer", "minimum": 1, "maximum": 9007199254740991},
    required=True,
)


def endpoint(
    operation_id: str,
    response: Any = None,
    *,
    request: Any = None,
    status: int = 200,
    paginated: bool = False,
    version_query: bool = False,
) -> Any:
    parameters = list(PAGE_PARAMETERS) if paginated else []
    if version_query:
        parameters.append(VERSION_PARAMETER)
    return extend_schema(
        operation_id=operation_id,
        request=request,
        responses={
            status: response,
            400: OpenApiTypes.OBJECT,
            403: ErrorOutput,
            404: ErrorOutput,
            409: ErrorOutput,
            429: ErrorOutput,
        },
        parameters=parameters,
    )

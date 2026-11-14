"""Strict, source-free learning invalidation protocol; this grants no authority."""

import json
import re
import uuid
from typing import Any, Literal, cast

from .notification_types import MAX_GENERATION, Audience

PROTOCOL = "code-along.learning-events"
VERSION = 1
MAX_COMMAND_BYTES = 1024
MAX_FRAME_BYTES = 4096
UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")


def generation(value: Any) -> int:
    if (
        not isinstance(value, str)
        or not DECIMAL.fullmatch(value)
        or int(value) > MAX_GENERATION
    ):
        raise ValueError("invalid_message")
    return int(value)


def uuid_value(value: Any) -> uuid.UUID:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("invalid_message")
    return uuid.UUID(value)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("invalid_message")
        result[key] = value
    return result


def _constant(value: str) -> Any:
    raise ValueError("invalid_message")


def subscribe(text: str) -> tuple[uuid.UUID, Audience, int | None]:
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_COMMAND_BYTES:
        raise ValueError("invalid_message")
    value = json.loads(text, object_pairs_hook=_object, parse_constant=_constant)
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "protocol",
            "version",
            "type",
            "scope",
            "assignment_id",
            "audience",
            "after_generation",
        }
        or value["protocol"] != PROTOCOL
        or type(value["version"]) not in (int, float)
        or value["version"] != VERSION
        or value["type"] != "subscribe"
        or value["scope"] != "assignment"
        or value["audience"] not in ("teaching", "participant")
    ):
        raise ValueError("invalid_message")
    return (
        uuid_value(value["assignment_id"]),
        cast(Audience, value["audience"]),
        None
        if value["after_generation"] is None
        else generation(value["after_generation"]),
    )


def envelope(assignment_id: uuid.UUID, audience: Audience) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "version": VERSION,
        "scope": "assignment",
        "assignment_id": str(assignment_id),
        "audience": audience,
    }


def frame(
    assignment_id: uuid.UUID,
    audience: Audience,
    kind: Literal["subscribed", "learning.changed", "head"],
    head: int,
    *,
    refresh_required: bool = False,
) -> dict[str, Any]:
    if type(head) is not int or not (0 <= head <= MAX_GENERATION):
        raise ValueError("invalid_message")
    if kind not in ("subscribed", "learning.changed", "head") or (
        kind == "learning.changed" and head == 0
    ):
        raise ValueError("invalid_message")
    result = {
        **envelope(assignment_id, audience),
        "type": kind,
        "head_generation": str(head),
    }
    if kind == "subscribed":
        result["refresh_required"] = refresh_required
    return result

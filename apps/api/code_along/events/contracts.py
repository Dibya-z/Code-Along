import re
import uuid
from datetime import UTC, datetime
from typing import Any

PROTOCOL = "code-along.events"
VERSION = 1
MAX_SEQUENCE = 9223372036854775807
MAX_FRAME_BYTES = 512 * 1024
MAX_COMMAND_BYTES = 1024
UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")


def sequence(value: Any) -> int:
    if (
        not isinstance(value, str)
        or not DECIMAL.fullmatch(value)
        or int(value) > MAX_SEQUENCE
    ):
        raise ValueError("invalid_sequence")
    return int(value)


def uuid_value(value: Any) -> uuid.UUID:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise ValueError("invalid_identity")
    return uuid.UUID(value)


def utc(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("invalid_timestamp")
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def subscribe(value: Any) -> tuple[uuid.UUID, int | None]:
    if (
        not isinstance(value, dict)
        or set(value) != {"protocol", "version", "type", "project_id", "after_sequence"}
        or value["protocol"] != PROTOCOL
        or type(value["version"]) is not int
        or value["version"] != VERSION
        or value["type"] != "subscribe"
    ):
        raise ValueError("invalid_message")
    return uuid_value(value["project_id"]), None if value[
        "after_sequence"
    ] is None else sequence(value["after_sequence"])

import codecs
import json
from collections.abc import Mapping
from typing import Any

from rest_framework.parsers import JSONParser

from .errors import SubmissionError

MAX_BODY_BYTES = 6 * 1024 * 1024 + 64 * 1024


def unique_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_field")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError("invalid_json_number")


def bounded_nesting(raw: bytes) -> None:
    depth = 0
    quoted = False
    escaped = False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > 32:
                raise ValueError("json_nesting_limit")
        elif byte in (93, 125):
            depth -= 1


class SubmissionJSONParser(JSONParser):
    def parse(
        self,
        stream: Any,
        media_type: str | None = None,
        parser_context: Mapping[str, Any] | None = None,
    ) -> Any:
        # Read the actual stream with a hard bound. Content-Length is not authority.
        raw = stream.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            raise SubmissionError(
                "submission_body_too_large",
                "Submission JSON exceeds the transport limit.",
                status=413,
            )
        try:
            bounded_nesting(raw)
            encoding = (parser_context or {}).get("encoding") or "utf-8"
            if codecs.lookup(encoding).name != "utf-8":
                raise ValueError("unsupported_encoding")
            return json.loads(
                raw.decode("utf-8", errors="strict"),
                object_pairs_hook=unique_fields,
                parse_constant=reject_constant,
            )
        except (UnicodeError, LookupError, RecursionError, ValueError, TypeError):
            raise SubmissionError(
                "invalid_submission_request",
                "Submission JSON is invalid UTF-8 or exceeds supported JSON nesting.",
                status=400,
            ) from None

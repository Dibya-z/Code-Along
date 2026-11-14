"""Exact manual plaintext and bounded HTTP commands; no grading execution."""

import codecs
import json
from collections.abc import Mapping
from typing import Any

from rest_framework.exceptions import ValidationError
from rest_framework.parsers import JSONParser

from code_along.learning.contracts import text

from .errors import SubmissionError
from .parsers import bounded_nesting, reject_constant, unique_fields

STATUSES = {"reviewed", "needs_changes", "complete"}
MAX_FEEDBACK_BODY_BYTES = 64 * 1024
MAX_COMMENT_BYTES = 8192
MAX_PUBLICATION_METADATA_BYTES = 16384
MAX_PUBLICATIONS = 20
MAX_SUBMISSION_FEEDBACK_BYTES = 128 * 1024
MAX_ASSIGNMENT_FEEDBACK_BYTES = 8 * 1024 * 1024
MAX_WORKSPACE_FEEDBACK_BYTES = 32 * 1024 * 1024
MAX_REVISION = 9007199254740991


def feedback_error(code: str, detail: str, *, status: int = 409) -> SubmissionError:
    return SubmissionError(code, detail, status=status)


def comments(
    value: Any, assessment: Any, *, publish: bool = False
) -> tuple[str, str | None]:
    if assessment is not None and (
        not isinstance(assessment, str) or assessment not in STATUSES
    ):
        raise feedback_error(
            "invalid_feedback_request",
            "Choose a supported manual assessment status.",
            status=400,
        )
    if publish and assessment is None:
        raise feedback_error(
            "feedback_draft_incomplete", "Choose a manual assessment before publishing."
        )
    try:
        result = text(
            value,
            MAX_COMMENT_BYTES,
            nonblank=assessment in {"reviewed", "needs_changes"},
        )
    except ValidationError:
        raise feedback_error(
            "invalid_feedback_request",
            "Use valid exact plaintext comments within the manual assessment limits.",
            status=400,
        ) from None
    return result, assessment


def increment(value: int) -> int:
    if value >= MAX_REVISION:
        raise feedback_error(
            "feedback_revision_conflict",
            "This feedback draft reached its revision limit.",
        )
    return value + 1


class FeedbackJSONParser(JSONParser):
    def parse(
        self,
        stream: Any,
        media_type: str | None = None,
        parser_context: Mapping[str, Any] | None = None,
    ) -> Any:
        raw = stream.read(MAX_FEEDBACK_BODY_BYTES + 1)
        if len(raw) > MAX_FEEDBACK_BODY_BYTES:
            raise feedback_error(
                "feedback_body_too_large", "Feedback JSON exceeds 64 KiB.", status=413
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
        except (UnicodeError, LookupError, ValueError, TypeError, RecursionError):
            raise feedback_error(
                "invalid_feedback_request",
                "Feedback JSON is invalid UTF-8 or unsupported JSON.",
                status=400,
            ) from None

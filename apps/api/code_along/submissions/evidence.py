"""Untrusted terminal claims, never grades or proof of execution."""

import re
import uuid
from typing import Any

from code_along.learning.contracts import digest
from code_along.learning.models import AssignmentVersion

from .errors import SubmissionError

DIGEST = re.compile(r"^[a-f0-9]{64}$")
RUN_FIELD_ORDER = ("kind", "run_id", "source_manifest_sha256", "status")
RUN_FIELDS = set(RUN_FIELD_ORDER)
CHECK_FIELD_ORDER = RUN_FIELD_ORDER + (
    "practice_manifest_sha256",
    "published_checks_sha256",
    "checks_sha256",
    "check_origin",
)
CHECK_FIELDS = set(CHECK_FIELD_ORDER)
STATUSES = {"succeeded", "failed", "cancelled", "timed_out", "output_limit"}


def parse_evidence(value: object, source_sha256: str) -> dict[str, Any] | None:
    if value is None:
        return None
    invalid = SubmissionError(
        "invalid_submission_evidence",
        "The reported practice evidence is invalid.",
        status=400,
    )
    if not isinstance(value, dict):
        raise invalid
    kind = value.get("kind")
    fields = (
        RUN_FIELDS
        if kind == "run"
        else CHECK_FIELDS
        if kind == "visible_checks"
        else set()
    )
    if (
        not fields
        or set(value) != fields
        or any(not isinstance(item, str) for item in value.values())
    ):
        raise invalid
    try:
        run_id = uuid.UUID(value["run_id"])
    except (ValueError, TypeError, AttributeError):
        raise invalid from None
    if (
        str(run_id) != value["run_id"]
        or run_id.version not in range(1, 9)
        or run_id.variant != uuid.RFC_4122
        or value["status"] not in STATUSES
        or value["source_manifest_sha256"] != source_sha256
    ):
        raise invalid
    if any(
        not DIGEST.fullmatch(value[key]) for key in fields if key.endswith("sha256")
    ):
        raise invalid
    if kind == "visible_checks" and value["check_origin"] not in {
        "published",
        "local_practice",
    }:
        raise invalid
    return {
        key: value[key]
        for key in (RUN_FIELD_ORDER if kind == "run" else CHECK_FIELD_ORDER)
    }


def require_pinned_evidence(
    value: dict[str, Any] | None, version: AssignmentVersion, source_sha256: str
) -> None:
    if value is None or value["kind"] == "run":
        return
    published = version.public_checks
    helper = version.helper_release
    valid = (
        published is not None
        and value["published_checks_sha256"] == published["sha256"]
    )
    if value["check_origin"] == "published":
        valid = valid and value["checks_sha256"] == value["published_checks_sha256"]
    expected = digest(
        [
            "code-along.practice-manifest",
            1,
            str(version.assignment_id),
            str(version.id),
            version.content_sha256,
            source_sha256,
            helper["release_id"],
            helper["source_sha256"],
            value["published_checks_sha256"],
            value["checks_sha256"],
            value["check_origin"],
        ]
    )
    if not valid or value["practice_manifest_sha256"] != expected:
        raise SubmissionError(
            "invalid_submission_evidence",
            "The reported checks do not match the pinned practice context.",
            status=400,
        )

"""Exact publication identities, without executing author-supplied Python."""

import hashlib
import json
import unicodedata
import uuid
from datetime import datetime
from typing import Any

from rest_framework.exceptions import ValidationError

from code_along.common.text import BLANK_CODEPOINTS
from code_along.events.contracts import utc

from .models import AssignmentVersion

MAX_ASSIGNMENTS = 100
MAX_VERSIONS = 50
MAX_VERSION_METADATA = 256 * 1024
MAX_ASSIGNMENT_METADATA = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 256 * 1024
# Version-one budget encoding is fixed even if a future migration adds an
# operational artifact-scope column to these otherwise immutable rows.
METADATA_V1_FIELDS = (
    "id",
    "assignment_id",
    "workspace_id",
    "number",
    "published_by_id",
    "author_display_name",
    "published_at",
    "client_request_id",
    "source_revision",
    "title",
    "instructions",
    "hints",
    "starter_project_id",
    "starter_revision_id",
    "starter_manifest_sha256",
    "runtime_profile_id",
    "runtime_identity",
    "runtime_manifest",
    "helper_release",
    "public_checks",
    "submission_mode",
    "max_attempts",
    "max_team_size",
    "due_at",
    "late_policy",
    "content_sha256",
)


def canonical(value: Any, *, sorted_keys: bool = False) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=sorted_keys,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8", errors="strict")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def text(value: Any, maximum: int, *, nonblank: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError("Use UTF-8 text.")
    try:
        raw = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise ValidationError("Use valid UTF-8 text.") from None
    if (
        b"\0" in raw
        or len(raw) > maximum
        or (nonblank and all(c in BLANK_CODEPOINTS for c in value))
    ):
        raise ValidationError(
            f"Use {'nonblank ' if nonblank else ''}text of at most {maximum} UTF-8 bytes without NUL."
        )
    return value


def label(value: Any, maximum: int) -> str:
    result = text(value, maximum * 4, nonblank=True)
    if len(result) > maximum or any(
        unicodedata.category(c) in {"Cc", "Cf", "Cs"} for c in result
    ):
        raise ValidationError(
            f"Use a plain label of at most {maximum} Unicode characters."
        )
    return result


def public_checks(source: str | None) -> dict[str, Any] | None:
    if source is None:
        return None
    source = text(source, 16384, nonblank=True)
    sha = hashlib.sha256(source.encode("utf-8")).hexdigest()
    return {
        "protocol": "code-along.public-checks",
        "version": 1,
        "language": "python",
        "source": source,
        "source_sha256": sha,
        "sha256": digest(["code-along.public-checks", 1, "python", sha, source]),
    }


def content_digest(version: AssignmentVersion) -> str:
    runtime, helper = version.runtime_identity, version.helper_release
    return digest(
        [
            "code-along.assignment-version",
            1,
            str(version.assignment_id),
            version.number,
            version.title,
            version.instructions,
            [[hint["id"], hint["title"], hint["body"]] for hint in version.hints],
            str(version.starter_revision_id),
            version.starter_manifest_sha256,
            runtime["runtime_id"],
            runtime["manifest_sha256"],
            runtime["engine"],
            runtime["engine_version"],
            runtime["python_version"],
            helper["release_id"],
            helper["source_sha256"],
            version.public_checks["sha256"] if version.public_checks else None,
            version.submission_mode,
            version.max_attempts,
            version.max_team_size,
            utc(version.due_at) if version.due_at else None,
            "reject",
        ]
    )


def version_metadata(version: AssignmentVersion) -> dict[str, Any]:
    """All original immutable metadata, using the fixed v1 budget encoding."""
    result = {}
    for name in METADATA_V1_FIELDS:
        value = getattr(version, name)
        if isinstance(value, uuid.UUID):
            value = str(value)
        elif isinstance(value, datetime):
            value = utc(value)
        result[name] = value
    return result


def metadata_size(version: AssignmentVersion) -> int:
    return len(canonical(version_metadata(version), sorted_keys=True))

"""Owned, exact product-v2 source values for private submission validation.

This module parses and hashes data only. A valid manifest grants no project,
participation or submission authority and never triggers learner-code execution.
"""

import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID

from rest_framework.exceptions import ValidationError

from code_along.projects.revision_contract import (
    DIGEST,
    HELPER_RELEASE,
    REVIEWED_IDENTITIES,
    RevisionContractError,
    revision_hash,
    source_digest,
    uuid_value,
    validate_manifest,
)
from code_along.projects.validation import (
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_PROJECT_BYTES,
    validate_paths,
)

MAX_SAFE_INTEGER = 9007199254740991
MAX_GENERATION = 2147483647
_MANIFEST_KEYS = {
    "version",
    "project_id",
    "source_kind",
    "metadata_version",
    "entrypoint_file_id",
    "runtime",
    "stdin_mode",
    "files",
    "sha256",
}
_RUNTIME_KEYS = {
    "runtime_id",
    "manifest_sha256",
    "engine",
    "engine_version",
    "python_version",
}
_FILE_KEYS = {"file_id", "document_id", "generation", "path", "source", "sha256"}


class SubmissionManifestError(ValueError):
    def __init__(self) -> None:
        super().__init__("invalid_submission_manifest")


def _object(value: object, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise SubmissionManifestError()
    return cast("dict[str, Any]", value)


def _text(value: object) -> str:
    if not isinstance(value, str):
        raise SubmissionManifestError()
    return value


def _integer(value: object, maximum: int, minimum: int = 1) -> int:
    # JSON has one Number type in JavaScript. Integral finite JSON floats must
    # hash as JSON.stringify's integer form, while bool is never a number here.
    if type(value) is int:
        number = value
    elif type(value) is float and math.isfinite(value) and value.is_integer():
        number = int(value)
    else:
        raise SubmissionManifestError()
    if not minimum <= number <= maximum:
        raise SubmissionManifestError()
    return number


def _uuid(value: object) -> UUID:
    if not uuid_value(value):
        raise SubmissionManifestError()
    return UUID(cast("str", value))


def _digest(value: object) -> str:
    digest = _text(value)
    if DIGEST.fullmatch(digest) is None:
        raise SubmissionManifestError()
    return digest


@dataclass(frozen=True, slots=True)
class ManifestRuntime:
    runtime_id: str
    manifest_sha256: str
    engine: Literal["pyodide"]
    engine_version: str
    python_version: str

    def as_dict(self) -> dict[str, str]:
        return {
            "runtime_id": self.runtime_id,
            "manifest_sha256": self.manifest_sha256,
            "engine": self.engine,
            "engine_version": self.engine_version,
            "python_version": self.python_version,
        }


@dataclass(frozen=True, slots=True)
class ManifestFile:
    file_id: UUID
    document_id: UUID
    generation: int
    path: str
    source: str
    sha256: str
    source_bytes: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "file_id": str(self.file_id),
            "document_id": str(self.document_id),
            "generation": self.generation,
            "path": self.path,
            "source": self.source,
            "sha256": self.sha256,
        }


@dataclass(frozen=True, slots=True)
class SubmissionManifest:
    project_id: UUID
    metadata_version: int
    entrypoint_file_id: UUID
    runtime: ManifestRuntime
    stdin_mode: Literal["batch", "interactive"]
    files: tuple[ManifestFile, ...]
    sha256: str
    source_bytes: int

    def as_manifest(self) -> dict[str, Any]:
        """Return fresh JSON data in the existing product-v2 canonical order."""
        return {
            "version": 2,
            "project_id": str(self.project_id),
            "source_kind": "project",
            "metadata_version": self.metadata_version,
            "entrypoint_file_id": str(self.entrypoint_file_id),
            "runtime": self.runtime.as_dict(),
            "stdin_mode": self.stdin_mode,
            "files": [file.as_dict() for file in self.files],
            "sha256": self.sha256,
        }

    def as_revision_manifest(self, helper_release: object) -> dict[str, Any]:
        """Prepare the distinct existing v1 artifact before domain locks."""
        if (
            not isinstance(helper_release, dict)
            or set(helper_release) != {"release_id", "source_sha256"}
            or helper_release != HELPER_RELEASE
        ):
            raise SubmissionManifestError()
        revision = {
            "protocol": "code-along.revision",
            "version": 1,
            "project_id": str(self.project_id),
            "metadata_version": self.metadata_version,
            "entrypoint_file_id": str(self.entrypoint_file_id),
            "runtime": self.runtime.as_dict(),
            "helper_release": dict(HELPER_RELEASE),
            "files": [file.as_dict() for file in self.files],
        }
        revision["sha256"] = revision_hash(revision)
        try:
            return validate_manifest(revision)
        except RevisionContractError:
            raise SubmissionManifestError() from None


def _runtime(value: object) -> ManifestRuntime:
    runtime = _object(value, _RUNTIME_KEYS)
    identity = {key: _text(item) for key, item in runtime.items()}
    reviewed = REVIEWED_IDENTITIES.get(identity["runtime_id"])
    if (
        reviewed is None
        or identity["engine"] != "pyodide"
        or (
            identity["manifest_sha256"],
            identity["engine_version"],
            identity["python_version"],
        )
        != reviewed
    ):
        raise SubmissionManifestError()
    return ManifestRuntime(
        runtime_id=identity["runtime_id"],
        manifest_sha256=identity["manifest_sha256"],
        engine="pyodide",
        engine_version=identity["engine_version"],
        python_version=identity["python_version"],
    )


def _canonical_bytes(manifest: SubmissionManifest) -> bytes:
    data = manifest.as_manifest()
    del data["sha256"]
    return json.dumps(
        data, ensure_ascii=False, allow_nan=False, separators=(",", ":")
    ).encode("utf-8")


def validate_submission_manifest(value: object) -> SubmissionManifest:
    """Validate one chosen value, including submission-only persistence bounds.

    Existing wire-v2 also permits local drafts and safe-integer generations above
    int32. Those cannot acquire submission authority or fit RevisionFile storage.
    No current-room reads, recapture or permission decision occurs here.
    """
    try:
        data = _object(value, _MANIFEST_KEYS)
        _integer(data["version"], 2, minimum=2)
        if data["source_kind"] != "project" or data["stdin_mode"] not in (
            "batch",
            "interactive",
        ):
            raise SubmissionManifestError()
        project_id = _uuid(data["project_id"])
        entrypoint = _uuid(data["entrypoint_file_id"])
        metadata_version = _integer(data["metadata_version"], MAX_SAFE_INTEGER)
        runtime = _runtime(data["runtime"])
        digest = _digest(data["sha256"])
        if (
            not isinstance(data["files"], list)
            or not 1 <= len(data["files"]) <= MAX_FILES
        ):
            raise SubmissionManifestError()
        # Reject every missing/extra file key and unsafe path before source hashing.
        rows = [_object(file, _FILE_KEYS) for file in data["files"]]
        paths = [_text(file["path"]) for file in rows]
        validate_paths(paths)
        if paths != sorted(paths):
            raise SubmissionManifestError()
        ids: set[UUID] = set()
        documents: set[UUID] = set()
        files: list[ManifestFile] = []
        total = 0
        for row, path in zip(rows, paths, strict=True):
            file_id, document_id = _uuid(row["file_id"]), _uuid(row["document_id"])
            generation = _integer(row["generation"], MAX_GENERATION)
            source = _text(row["source"])
            expected = _digest(row["sha256"])
            if (
                file_id in ids
                or document_id in documents
                or len(source) > MAX_FILE_BYTES
            ):
                raise SubmissionManifestError()
            size, actual = source_digest(source)
            total += size
            if actual != expected or total > MAX_PROJECT_BYTES:
                raise SubmissionManifestError()
            files.append(
                ManifestFile(
                    file_id, document_id, generation, path, source, actual, size
                )
            )
            ids.add(file_id)
            documents.add(document_id)
        if entrypoint not in ids:
            raise SubmissionManifestError()
        manifest = SubmissionManifest(
            project_id,
            metadata_version,
            entrypoint,
            runtime,
            cast("Literal['batch', 'interactive']", data["stdin_mode"]),
            tuple(files),
            digest,
            total,
        )
        if hashlib.sha256(_canonical_bytes(manifest)).hexdigest() != digest:
            raise SubmissionManifestError()
        return manifest
    except (KeyError, TypeError, UnicodeError, RevisionContractError, ValidationError):
        raise SubmissionManifestError() from None

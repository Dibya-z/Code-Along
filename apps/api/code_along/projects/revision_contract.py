"""The exact frozen source/runtime/helper manifest shared with the coordinator."""

import hashlib
import json
import re
from typing import Any

from rest_framework.exceptions import ValidationError

from .models import RuntimeProfile
from .runtime_catalog import RUNTIME_ID
from .validation import MAX_FILE_BYTES, MAX_PROJECT_BYTES, validate_paths

HELPER_RELEASE = {
    "release_id": "code-along-python-helpers-v1",
    "source_sha256": "4b1ccdc64d339bad3c96154b465214f94e414b8b230cd50e59a478ca7fce51b1",
}
UUID_PATTERN = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z"
)
DIGEST = re.compile(r"[a-f0-9]{64}\Z")
REVIEWED_IDENTITIES = {
    RUNTIME_ID: (
        "4eb12f345e0f14f57c93603c8d8a2d3d62c69e2e82618c63cac87dc0aafadf40",
        "314.0.7",
        "3.14.2",
    ),
    "pyodide-314.0.7-scientific": (
        "eb2bfd5f172ccce38411575452b4c723f939a14e095a94a612fb1f9d5fdf21ea",
        "314.0.7",
        "3.14.2",
    ),
}


class RevisionContractError(ValueError):
    def __init__(self) -> None:
        super().__init__("invalid_revision_manifest")


def exact(value: Any, keys: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == keys


def uuid_value(value: Any) -> bool:
    return isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None


def source_digest(source: str) -> tuple[int, str]:
    try:
        encoded = source.encode("utf-8", errors="strict")
    except UnicodeError:
        raise RevisionContractError() from None
    if b"\0" in encoded or len(encoded) > MAX_FILE_BYTES:
        raise RevisionContractError()
    return len(encoded), hashlib.sha256(encoded).hexdigest()


def runtime_identity(profile: RuntimeProfile) -> dict[str, str]:
    manifest = profile.manifest
    if not isinstance(manifest, dict) or any(
        not isinstance(manifest.get(key), str) for key in ("runtime_id", "version_pin")
    ):
        raise RevisionContractError()
    actual = hashlib.sha256(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if (
        actual != profile.manifest_sha256
        or manifest["runtime_id"] != profile.runtime_id
    ):
        raise RevisionContractError()
    reviewed = REVIEWED_IDENTITIES.get(profile.runtime_id)
    if (
        reviewed is None
        or (profile.manifest_sha256, manifest["version_pin"]) != reviewed[:2]
        or manifest.get("python_version", reviewed[2]) != reviewed[2]
    ):
        raise RevisionContractError()
    return {
        "runtime_id": profile.runtime_id,
        "manifest_sha256": profile.manifest_sha256,
        "engine": "pyodide",
        "engine_version": manifest["version_pin"],
        "python_version": reviewed[2],
    }


def revision_hash(manifest: dict[str, Any]) -> str:
    runtime, helper = manifest["runtime"], manifest["helper_release"]
    canonical = [
        "code-along.revision",
        1,
        manifest["project_id"],
        manifest["metadata_version"],
        manifest["entrypoint_file_id"],
        runtime["runtime_id"],
        runtime["manifest_sha256"],
        runtime["engine"],
        runtime["engine_version"],
        runtime["python_version"],
        helper["release_id"],
        helper["source_sha256"],
        [
            [
                file["file_id"],
                file["document_id"],
                file["generation"],
                file["path"],
                file["sha256"],
                file["source"],
            ]
            for file in manifest["files"]
        ],
    ]
    return hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_manifest(value: Any) -> dict[str, Any]:
    try:
        if (
            not exact(
                value,
                {
                    "protocol",
                    "version",
                    "project_id",
                    "metadata_version",
                    "entrypoint_file_id",
                    "runtime",
                    "helper_release",
                    "files",
                    "sha256",
                },
            )
            or value["protocol"] != "code-along.revision"
            or type(value["version"]) is not int
            or value["version"] != 1
            or not uuid_value(value["project_id"])
            or not uuid_value(value["entrypoint_file_id"])
            or type(value["metadata_version"]) is not int
            or not 1 <= value["metadata_version"] <= 9007199254740991
            or not exact(
                value["runtime"],
                {
                    "runtime_id",
                    "manifest_sha256",
                    "engine",
                    "engine_version",
                    "python_version",
                },
            )
            or any(not isinstance(item, str) for item in value["runtime"].values())
            or value["runtime"]["engine"] != "pyodide"
            or not DIGEST.fullmatch(value["runtime"]["manifest_sha256"])
            or value["helper_release"] != HELPER_RELEASE
            or not isinstance(value["files"], list)
            or not 1 <= len(value["files"]) <= 20
            or not isinstance(value["sha256"], str)
            or not DIGEST.fullmatch(value["sha256"])
        ):
            raise RevisionContractError()
        ids, documents, paths = set(), set(), []
        total = 0
        for file in value["files"]:
            if (
                not exact(
                    file,
                    {
                        "file_id",
                        "document_id",
                        "generation",
                        "path",
                        "source",
                        "sha256",
                    },
                )
                or not uuid_value(file["file_id"])
                or not uuid_value(file["document_id"])
                or file["file_id"] in ids
                or file["document_id"] in documents
                or type(file["generation"]) is not int
                or not 1 <= file["generation"] <= 2147483647
                or not isinstance(file["path"], str)
                or not isinstance(file["source"], str)
                or not isinstance(file["sha256"], str)
            ):
                raise RevisionContractError()
            length, digest = source_digest(file["source"])
            if file["sha256"] != digest:
                raise RevisionContractError()
            total += length
            ids.add(file["file_id"])
            documents.add(file["document_id"])
            paths.append(file["path"])
        validate_paths(paths)
        if (
            total > MAX_PROJECT_BYTES
            or paths != sorted(paths)
            or value["entrypoint_file_id"] not in ids
            or revision_hash(value) != value["sha256"]
        ):
            raise RevisionContractError()
        # Preserve exact source while severing all caller-owned mutable references.
        return dict(json.loads(json.dumps(value, ensure_ascii=False)))
    except (KeyError, TypeError, UnicodeError, ValidationError):
        raise RevisionContractError() from None

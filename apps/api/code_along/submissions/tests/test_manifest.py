"""Pure cross-language source validation; no database or learner execution."""

import copy
import hashlib
import json
from dataclasses import FrozenInstanceError
from pathlib import Path
from typing import Any

import pytest

from code_along.projects.revision_contract import HELPER_RELEASE
from code_along.submissions.manifest import (
    SubmissionManifestError,
    validate_submission_manifest,
)

FIXTURE = (
    Path(__file__).resolve().parents[5]
    / "packages/contracts/fixtures/submission-manifests.json"
)
CORPUS: dict[str, Any] = json.loads(FIXTURE.read_text())
CASES: dict[str, dict[str, Any]] = {case["name"]: case for case in CORPUS["cases"]}
CANONICAL: dict[str, Any] = json.loads(CASES["empty"]["canonical_json"])


def materialize(case: dict[str, Any]) -> dict[str, Any]:
    if "raw_manifest_json" in case:
        return dict(json.loads(case["raw_manifest_json"]))
    manifest: dict[str, Any] = copy.deepcopy(case["manifest"])
    for file in manifest["files"]:
        recipe = case.get("source_recipes", {}).get(file["path"])
        if recipe:
            file["source"] = (
                recipe["prefix"] + recipe["unit"] * recipe["repeat"] + recipe["suffix"]
            )
    return manifest


def rehash_adversarial(manifest: dict[str, Any]) -> dict[str, Any]:
    """Make limits/structural attacks self-consistent, rather than merely stale.

    Field order comes from the independent static canonical-byte fixture. This
    helper never validates values and is not a production manifest encoder.
    """
    data = copy.deepcopy(manifest)
    for file in data["files"]:
        file["sha256"] = hashlib.sha256(file["source"].encode("utf-8")).hexdigest()
    canonical: dict[str, Any] = {}
    for key in CANONICAL:
        if key == "runtime":
            canonical[key] = {field: data[key][field] for field in CANONICAL[key]}
        elif key == "files":
            canonical[key] = [
                {field: file[field] for field in CANONICAL["files"][0]}
                for file in data[key]
            ]
        else:
            canonical[key] = data[key]
    data["sha256"] = hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return data


def mutate_attribute(target: object, name: str, value: object) -> None:
    """Exercise runtime ownership from an untyped caller despite readonly types."""
    setattr(target, name, value)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=list(CASES))
def test_actual_typescript_vectors_and_distinct_v1_artifacts(
    case: dict[str, Any],
) -> None:
    value = materialize(case)
    if not case["submission_valid"]:
        # These two values are valid wire-v2 values, intentionally outside the
        # private submission persistence/authority domain.
        assert case["wire_valid"] is True
        with pytest.raises(
            SubmissionManifestError, match="^invalid_submission_manifest$"
        ):
            validate_submission_manifest(value)
        return
    manifest = validate_submission_manifest(value)
    assert manifest.sha256 == case["manifest"]["sha256"]
    assert manifest.source_bytes == case["source_bytes"]
    assert manifest.as_manifest() == value
    assert all(type(file.generation) is int for file in manifest.files)
    assert type(manifest.metadata_version) is int
    assert sum(file.source_bytes for file in manifest.files) == manifest.source_bytes
    for file in manifest.files:
        assert file.source_bytes == len(file.source.encode("utf-8"))
        assert hashlib.sha256(file.source.encode("utf-8")).hexdigest() == file.sha256
    artifact = manifest.as_revision_manifest(dict(HELPER_RELEASE))
    assert artifact["sha256"] == case["artifact_manifest_sha256"]
    assert artifact["sha256"] != manifest.sha256
    assert artifact["files"] == manifest.as_manifest()["files"]


@pytest.mark.parametrize(
    "rejection", CORPUS["rejections"], ids=[row["name"] for row in CORPUS["rejections"]]
)
def test_shared_malformed_values_are_rejected(rejection: dict[str, Any]) -> None:
    value = materialize(CASES["empty"])
    target = value
    for segment in rejection["path"][:-1]:
        target = target[segment]
    target[rejection["path"][-1]] = (
        json.loads(rejection["value_json"])
        if "value_json" in rejection
        else copy.deepcopy(rejection["value"])
    )
    with pytest.raises(SubmissionManifestError, match="^invalid_submission_manifest$"):
        validate_submission_manifest(value)


def test_integral_json_numbers_normalize_without_changing_any_source_bytes() -> None:
    value = materialize(CASES["integral-number-json-lexemes"])
    assert type(value["version"]) is float
    assert type(value["metadata_version"]) is float
    assert type(value["files"][0]["generation"]) is float
    manifest = validate_submission_manifest(value)
    normalized = manifest.as_manifest()
    assert type(normalized["version"]) is int
    assert type(normalized["metadata_version"]) is int
    assert type(normalized["files"][0]["generation"]) is int
    assert normalized["metadata_version"] == 1000
    assert normalized["files"][0]["source"] == value["files"][0]["source"]
    assert (
        manifest.sha256 == CASES["integral-number-json-lexemes"]["manifest"]["sha256"]
    )


@pytest.mark.parametrize("number", [float("nan"), float("inf"), float("-inf")])
@pytest.mark.parametrize("field", ["version", "metadata_version", "generation"])
def test_nonfinite_numbers_fail_with_a_bounded_parser_error(
    number: float, field: str
) -> None:
    value = materialize(CASES["empty"])
    target = value["files"][0] if field == "generation" else value
    target[field] = number
    with pytest.raises(SubmissionManifestError, match="^invalid_submission_manifest$"):
        validate_submission_manifest(value)


def test_ordered_canonical_bytes_are_pinned_but_input_object_order_is_irrelevant() -> (
    None
):
    case = CASES["empty"]
    value = materialize(case)
    value = dict(reversed(list(value.items())))
    value["runtime"] = dict(reversed(list(value["runtime"].items())))
    value["files"] = [dict(reversed(list(file.items()))) for file in value["files"]]
    manifest = validate_submission_manifest(value)
    canonical = manifest.as_manifest()
    del canonical["sha256"]
    encoded = json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    assert encoded == case["canonical_json"].encode("utf-8")
    assert hashlib.sha256(encoded).hexdigest() == case["manifest"]["sha256"]


def test_accepted_values_and_all_output_mappings_own_their_nested_state() -> None:
    original = materialize(CASES["leading-bom"])
    manifest = validate_submission_manifest(original)
    expected = copy.deepcopy(original)
    original["runtime"]["engine_version"] = "changed"
    original["files"][0].update(source="changed", generation=2, path="changed.py")
    original["files"].clear()
    assert manifest.as_manifest() == expected
    output = manifest.as_manifest()
    output["runtime"]["engine_version"] = "changed"
    output["files"][0]["source"] = "changed"
    assert manifest.as_manifest() == expected
    runtime = manifest.runtime.as_dict()
    runtime["engine_version"] = "changed"
    assert manifest.runtime.engine_version != "changed"
    with pytest.raises(FrozenInstanceError):
        mutate_attribute(manifest, "metadata_version", 2)
    with pytest.raises(FrozenInstanceError):
        mutate_attribute(manifest.runtime, "engine_version", "changed")
    with pytest.raises(FrozenInstanceError):
        mutate_attribute(manifest.files[0], "source", "changed")
    helper = dict(HELPER_RELEASE)
    artifact = manifest.as_revision_manifest(helper)
    helper["source_sha256"] = "changed"
    artifact["files"][0]["source"] = "changed"
    artifact["helper_release"]["source_sha256"] = "changed"
    assert (
        manifest.as_revision_manifest(dict(HELPER_RELEASE))["sha256"]
        == CASES["leading-bom"]["artifact_manifest_sha256"]
    )
    assert manifest.files[0].source.startswith("\ufeff")


def test_distinct_modes_change_only_run_identity_and_unicode_is_never_normalized() -> (
    None
):
    batch = validate_submission_manifest(materialize(CASES["empty"]))
    interactive = validate_submission_manifest(materialize(CASES["empty-interactive"]))
    assert batch.sha256 != interactive.sha256
    assert batch.as_revision_manifest(
        dict(HELPER_RELEASE)
    ) == interactive.as_revision_manifest(dict(HELPER_RELEASE))
    assert (
        CASES["precomposed"]["manifest"]["sha256"]
        != CASES["combining"]["manifest"]["sha256"]
    )


@pytest.mark.parametrize("name", ["utf8-file-exact-limit", "bom-file-exact-limit"])
def test_one_byte_file_overflow_has_valid_hashes_and_still_fails(name: str) -> None:
    value = materialize(CASES[name])
    value["files"][0]["source"] += "x"
    value = rehash_adversarial(value)
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(value)


def test_aggregate_one_byte_overflow_keeps_every_file_below_its_own_limit() -> None:
    value = materialize(CASES["aggregate-exact-limit"])
    extra = copy.deepcopy(value["files"][0])
    extra.update(
        file_id="00000000-0000-4000-8000-000000000009",
        document_id="00000000-0000-4000-8000-000000000109",
        path="m08.py",
        source="x",
    )
    value["files"].append(extra)
    value = rehash_adversarial(value)
    assert max(len(file["source"].encode("utf-8")) for file in value["files"]) == 131072
    assert (
        sum(len(file["source"].encode("utf-8")) for file in value["files"]) == 1048577
    )
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(value)


def test_twenty_one_empty_or_small_files_have_valid_hashes_and_still_fail() -> None:
    value = materialize(CASES["twenty-source-files"])
    extra = copy.deepcopy(value["files"][0])
    extra.update(
        file_id="00000000-0000-4000-8000-000000000021",
        document_id="00000000-0000-4000-8000-000000000121",
        path="m20.py",
        source="",
    )
    value["files"].append(extra)
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(rehash_adversarial(value))


@pytest.mark.parametrize(
    "attack",
    [
        "file-id",
        "document-id",
        "case-path",
        "module-folder",
        "order",
        "entrypoint",
        "nul",
        "runtime",
    ],
)
def test_self_consistent_hashes_cannot_bypass_structural_source_or_runtime_guards(
    attack: str,
) -> None:
    value = materialize(CASES["twenty-source-files"])
    if attack in {"file-id", "document-id"}:
        field = "file_id" if attack == "file-id" else "document_id"
        value["files"][1][field] = value["files"][0][field]
    elif attack in {"case-path", "module-folder"}:
        value["files"] = value["files"][:2]
        value["files"][0]["path"] = "MAIN.py" if attack == "case-path" else "a.py"
        value["files"][1]["path"] = "main.py" if attack == "case-path" else "a/main.py"
    elif attack == "order":
        value["files"].reverse()
    elif attack == "entrypoint":
        value["entrypoint_file_id"] = "00000000-0000-4000-8000-000000000999"
    elif attack == "nul":
        value["files"][0]["source"] = "\0"
    elif attack == "runtime":
        value["runtime"]["manifest_sha256"] = "0" * 64
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(rehash_adversarial(value))


@pytest.mark.parametrize("location", ["top", "runtime", "file"])
def test_missing_fields_fail_before_hashing(location: str) -> None:
    value = materialize(CASES["empty"])
    target = (
        value
        if location == "top"
        else value["runtime"]
        if location == "runtime"
        else value["files"][0]
    )
    del target[next(iter(target))]
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(value)


def test_a_local_draft_cannot_be_relabelled_using_a_project_hash() -> None:
    value = materialize(CASES["empty"])
    value["source_kind"] = "local_draft"
    with pytest.raises(SubmissionManifestError):
        validate_submission_manifest(value)


@pytest.mark.parametrize(
    "helper",
    [
        None,
        {},
        {**HELPER_RELEASE, "extra": True},
        {**HELPER_RELEASE, "source_sha256": "0" * 64},
    ],
)
def test_artifact_mapping_requires_the_exact_reviewed_helper(helper: object) -> None:
    manifest = validate_submission_manifest(materialize(CASES["empty"]))
    with pytest.raises(SubmissionManifestError):
        manifest.as_revision_manifest(helper)

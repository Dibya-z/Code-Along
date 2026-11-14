import copy
import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from rest_framework.exceptions import ValidationError

from code_along.chat.services import BLANK_CODEPOINTS
from code_along.learning import contracts, dto
from code_along.learning.models import AssignmentVersion


@pytest.mark.parametrize("value", list(BLANK_CODEPOINTS))
def test_all_shared_blank_scalars_reject_but_exact_visible_prose_survives(
    value: str,
) -> None:
    with pytest.raises(ValidationError):
        contracts.text(value, 32768, nonblank=True)
    assert (
        contracts.text(value + "π🐍\r\n" + value, 32768, nonblank=True)
        == value + "π🐍\r\n" + value
    )


@pytest.mark.parametrize("value", [True, 1, None, "\0", "\ud800"])
def test_invalid_text_never_coerces_or_normalizes(value: Any) -> None:
    with pytest.raises(ValidationError):
        contracts.text(value, 100)


def test_exact_utf8_boundaries_plain_labels_and_public_checks_golden() -> None:
    source = '# π🐍\r\nassert "café" != "café"\n'
    check = contracts.public_checks(source)
    assert check is not None and check["source"] == source
    expected_source = hashlib.sha256(source.encode("utf-8")).hexdigest()
    expected = hashlib.sha256(
        json.dumps(
            ["code-along.public-checks", 1, "python", expected_source, source],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    assert check["source_sha256"] == expected_source
    assert check["sha256"] == expected
    assert (
        expected_source
        == "62ce43716734183b149ca52d3cc86a1a1d12186f4d713a2fdaeb829d73610112"
    )
    assert (
        expected == "a59661852e585a6785cb4a9a541cdf8babf509e46011d98aa22a8234bfa2b47f"
    )
    assert contracts.text("🐍" * 8192, 32768) == "🐍" * 8192
    with pytest.raises(ValidationError):
        contracts.text("🐍" * 8192 + "x", 32768)
    assert contracts.label("🐍" * 120, 120) == "🐍" * 120
    for bad in ("\tTitle", "Title\u200b", "🐍" * 121):
        with pytest.raises(ValidationError):
            contracts.label(bad, 120)


@pytest.mark.parametrize("value", [True, "1", 1.0])
def test_revision_is_a_strict_json_integer(value: Any) -> None:
    body = dto.AssignmentPublish(
        data={"expected_revision": value, "client_request_id": str(uuid.uuid4())}
    )
    assert not body.is_valid()


@pytest.mark.parametrize(
    "fields",
    [
        {"hints": [{"id": str(uuid.uuid4()), "title": "Hint", "body": "\ufeff"}]},
        {"instructions": "\udfff"},
        {"public_checks_source": "\u0085"},
        {"due_at": "2030-01-01T01:00:00"},
        {"max_attempts": "3"},
        {"starter_project_id": str(uuid.uuid4())},
        {"title": False},
    ],
)
def test_draft_rejects_invalid_fields(fields: dict[str, Any]) -> None:
    body = dto.AssignmentDraftPatch(data={"expected_revision": 1, **fields})
    assert not body.is_valid()


def test_metadata_encoding_covers_every_original_field_and_is_stable_against_future_operational_attributes() -> (
    None
):
    version = AssignmentVersion(
        id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
        assignment_id=uuid.UUID("00000000-0000-4000-8000-000000000002"),
        workspace_id=uuid.uuid4(),
        published_by_id=uuid.uuid4(),
        number=1,
        author_display_name="Teacher π",
        published_at=datetime(2030, 1, 1, tzinfo=UTC),
        client_request_id=uuid.uuid4(),
        source_revision=4,
        title="Assignment 🐍",
        instructions="exact\r\n",
        hints=[],
        starter_project_id=uuid.uuid4(),
        starter_revision_id=uuid.uuid4(),
        starter_manifest_sha256="a" * 64,
        runtime_profile_id=uuid.uuid4(),
        runtime_identity={"runtime_id": "runtime"},
        runtime_manifest={"quote": '"\\π'},
        helper_release={"release_id": "helper"},
        public_checks=None,
        submission_mode="individual",
        max_attempts=10,
        max_team_size=1,
        content_sha256="b" * 64,
    )
    original = {field.attname for field in version._meta.concrete_fields} - {
        "metadata_bytes",
        "starter_scope",
    }
    assert set(contracts.METADATA_V1_FIELDS) == original
    encoded = contracts.canonical(contracts.version_metadata(version), sorted_keys=True)
    assert contracts.metadata_size(version) == len(encoded)
    assert json.loads(encoded)["instructions"] == "exact\r\n"
    version.metadata_bytes = 42
    # Unsaved encoding probe only: database scope policy is tested separately.
    version.starter_scope = "submission"
    assert (
        contracts.canonical(contracts.version_metadata(version), sorted_keys=True)
        == encoded
    )
    copied = copy.deepcopy(version)
    copied.runtime_manifest = {"quote": '"\\π', "additional": "runtime inventory"}
    assert contracts.metadata_size(copied) > contracts.metadata_size(version)

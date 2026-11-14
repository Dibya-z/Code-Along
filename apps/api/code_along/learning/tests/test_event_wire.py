import json
import uuid
from typing import Any

import pytest

from code_along.learning import event_wire as wire

ASSIGNMENT = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")


def command(**values: Any) -> str:
    return json.dumps(
        {
            **wire.envelope(ASSIGNMENT, "participant"),
            "type": "subscribe",
            "after_generation": None,
            **values,
        }
    )


@pytest.mark.parametrize("version", [1, 1.0])
def test_subscribe_accepts_json_numeric_one_and_lossless_int64(
    version: int | float,
) -> None:
    assert wire.subscribe(
        command(version=version, after_generation=str(2**63 - 1))
    ) == (
        ASSIGNMENT,
        "participant",
        2**63 - 1,
    )
    assert wire.subscribe(command().replace('"version": 1', '"version": 1e0')) == (
        ASSIGNMENT,
        "participant",
        None,
    )


@pytest.mark.parametrize(
    "value", [0, True, "00", "01", "-1", "1.0", "١", str(2**63), "1\n"]
)
def test_generation_is_bounded_ascii_canonical_decimal(value: Any) -> None:
    with pytest.raises(ValueError):
        wire.subscribe(command(after_generation=value))


@pytest.mark.parametrize(
    "values",
    [
        {"user_id": str(ASSIGNMENT)},
        {"stream_id": str(ASSIGNMENT)},
        {"protocol": "code-along.events"},
        {"version": True},
        {"version": "1"},
        {"version": float("nan")},
        {"version": float("inf")},
        {"version": 10**500},
        {"assignment_id": str(ASSIGNMENT).upper()},
        {"assignment_id": str(ASSIGNMENT) + "\n"},
        {"assignment_id": "bbbbbbbb-bbbb-0bbb-8bbb-bbbbbbbbbbbb"},
        {"scope": "project"},
        {"audience": ["participant"]},
        {"type": "head"},
    ],
)
def test_subscribe_rejects_wrong_types_unknown_keys_and_foreign_protocol(
    values: dict[str, Any],
) -> None:
    with pytest.raises(ValueError):
        wire.subscribe(command(**values))


def test_subscribe_rejects_duplicate_keys_and_actual_utf8_overflow() -> None:
    original = command()
    for invalid in (
        original.replace('"version": 1', '"version": 1, "version": 1'),
        original.replace('"version": 1', '"version": 1, "ver\\u0073ion": 1'),
        original + " " * (wire.MAX_COMMAND_BYTES + 1),
        original + "\u2000" * 400,
        '[{"a": 1, "a": 2}]',
    ):
        with pytest.raises(ValueError):
            wire.subscribe(invalid)


def test_exact_frames_have_no_source_or_internal_identity() -> None:
    for kind in ("head", "learning.changed", "subscribed"):
        result = wire.frame(ASSIGNMENT, "teaching", kind, 2**63 - 1)
        assert set(result) == {
            "protocol",
            "version",
            "scope",
            "assignment_id",
            "audience",
            "type",
            "head_generation",
        } | ({"refresh_required"} if kind == "subscribed" else set())
        assert result["head_generation"] == str(2**63 - 1)
        assert len(json.dumps(result).encode()) < wire.MAX_FRAME_BYTES
    for value in (True, -1, 2**63):
        with pytest.raises(ValueError):
            wire.frame(ASSIGNMENT, "participant", "head", value)
    with pytest.raises(ValueError):
        wire.frame(ASSIGNMENT, "participant", "learning.changed", 0)

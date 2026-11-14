import io
from typing import Any

import pytest

from code_along.submissions.errors import SubmissionError
from code_along.submissions.parsers import MAX_BODY_BYTES, SubmissionJSONParser


@pytest.mark.parametrize(
    "raw",
    [
        b'{"a":1,"a":2}',
        b'{"a":NaN}',
        b'{"a":Infinity}',
        b'{"a":"\xff"}',
        b"[" * 2000 + b"]" * 2000,
        b"{",
    ],
)
def test_invalid_bounded_json_is_generic_400(raw: bytes) -> None:
    with pytest.raises(SubmissionError) as error:
        SubmissionJSONParser().parse(io.BytesIO(raw))
    assert error.value.status_code == 400
    assert isinstance(error.value.detail, dict)
    assert error.value.detail["code"] == "invalid_submission_request"


@pytest.mark.parametrize(
    "encoding", ["bogus-charset", "bz2_codec", "utf-16", "latin-1"]
)
def test_only_utf8_json_is_accepted(encoding: str) -> None:
    with pytest.raises(SubmissionError) as error:
        SubmissionJSONParser().parse(
            io.BytesIO(b"{}"), parser_context={"encoding": encoding}
        )
    assert error.value.status_code == 400


class ObservedStream(io.BytesIO):
    def __init__(self, value: bytes) -> None:
        super().__init__(value)
        self.requests: list[int] = []

    def read(self, size: int | None = -1) -> bytes:
        assert size is not None and 0 <= size <= MAX_BODY_BYTES + 1
        self.requests.append(size)
        return super().read(size)


@pytest.mark.parametrize("declared", [None, 0, 1, 999999999])
def test_actual_stream_overflow_is_bounded_before_json_allocation(
    declared: int | None,
) -> None:
    stream = ObservedStream(b" " * (MAX_BODY_BYTES + 2))
    context: dict[str, Any] = {"content_length": declared}
    with pytest.raises(SubmissionError) as error:
        SubmissionJSONParser().parse(stream, parser_context=context)
    assert error.value.status_code == 413 and stream.tell() == MAX_BODY_BYTES + 1
    assert stream.requests == [MAX_BODY_BYTES + 1]


def test_json_literal_and_escaped_unicode_preserve_source() -> None:
    assert SubmissionJSONParser().parse(io.BytesIO(b'{"source":"\\ufeffa\\r\\n"}')) == {
        "source": "\ufeffa\r\n"
    }


@pytest.mark.parametrize(
    "source",
    [
        "[" * 2000 + "]" * 2000,
        "{" * 2000 + "}" * 2000,
        '"\\\\\\"' + ("[{" * 100) + '\\"tail',
        'braces [ ] { } inside \\"quoted\\" source',
    ],
)
def test_nesting_scanner_does_not_count_string_contents_or_escaped_quotes(
    source: str,
) -> None:
    import json

    raw = json.dumps({"source": source}, ensure_ascii=False).encode()
    assert SubmissionJSONParser().parse(io.BytesIO(raw)) == {"source": source}

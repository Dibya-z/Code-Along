import unicodedata

import pytest

from code_along.collaboration.profiles import public_display_name


@pytest.mark.parametrize(
    "name,expected",
    [
        ("River", "River"),
        ("River\n\tStone", "River Stone"),
        (" A\x01\x7f\x85B\u202eC\ud800D ", "A B C D"),
        ("\x01\u200b\u202e\t\n", "Learner"),
        ("🐍" * 80, "🐍" * 80),
        ("🐍" * 90, "🐍" * 80),
        ("नदी 雪", "नदी 雪"),
    ],
)
def test_public_presence_label_preserves_valid_unicode_and_bounds_controls(
    name: str, expected: str
) -> None:
    projected = public_display_name(name)
    assert projected == expected
    assert projected and len(projected) <= 80
    assert all(
        unicodedata.category(character) not in {"Cc", "Cf", "Cs"}
        for character in projected
    )

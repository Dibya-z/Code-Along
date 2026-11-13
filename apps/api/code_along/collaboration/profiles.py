import unicodedata


def public_display_name(value: str) -> str:
    """A bounded plain presence label; the account's stored name is unchanged."""
    plain = "".join(
        " " if unicodedata.category(character) in {"Cc", "Cf", "Cs"} else character
        for character in value
    )
    return " ".join(plain.split())[:80].strip() or "Learner"

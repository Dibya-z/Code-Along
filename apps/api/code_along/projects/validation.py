import hashlib
import re
from collections.abc import Sequence

from rest_framework.exceptions import ValidationError

MAX_FILES = 20
MAX_FILE_BYTES = 128 * 1024
MAX_PROJECT_BYTES = 1024 * 1024


def source_digest(source: str) -> tuple[int, str]:
    try:
        data = source.encode("utf-8", errors="strict")
        if b"\0" in data or len(data) > MAX_FILE_BYTES:
            raise ValueError
    except (UnicodeError, ValueError) as error:
        raise ValidationError(
            {
                "initial_source": "Use valid UTF-8 Python source of at most 128 KiB, without NUL bytes."
            }
        ) from error
    return len(data), hashlib.sha256(data).hexdigest()


def validate_paths(paths: Sequence[str]) -> None:
    if len(paths) > MAX_FILES:
        raise ValidationError({"path": "A project supports at most 20 files."})
    seen: set[str] = set()
    modules: set[tuple[str, ...]] = set()
    directories: set[tuple[str, ...]] = set()
    for path in paths:
        if len(path) > 160 or not re.fullmatch(
            r"[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*\.py", path
        ):
            raise ValidationError(
                {
                    "path": "Use a relative Python module path, such as lessons/main.py. No traversal, absolute paths or special characters."
                }
            )
        normalized = path.casefold()
        if normalized in seen:
            raise ValidationError({"path": "A file with this path already exists."})
        seen.add(normalized)
        parts = tuple(normalized[:-3].split("/"))
        for length in range(1, len(parts)):
            directories.add(parts[:length])
        if parts[-1] != "__init__":
            modules.add(parts)
    if modules & directories:
        raise ValidationError(
            {"path": "A Python module and a directory cannot use the same import name."}
        )

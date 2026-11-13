"""Development upgrades preserve existing credentials and never expose them."""

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from tools.dev.init_development import SECRET_KEYS, prepare_environment


def assignments(path: Path) -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in path.read_text().splitlines()
        if line and not line.startswith("#")
    )


def test_new_environment_is_private_complete_and_idempotent(tmp_path):
    path = tmp_path / ".env"
    prepare_environment(path)
    first = path.read_bytes()
    values = assignments(path)
    assert set(SECRET_KEYS).issubset(values)
    assert len({values[key] for key in SECRET_KEYS}) == len(SECRET_KEYS)
    assert all(len(values[key]) >= 43 for key in SECRET_KEYS)
    assert path.stat().st_mode & 0o777 == 0o600
    prepare_environment(path)
    assert path.read_bytes() == first


def test_upgrade_preserves_original_bytes_and_missing_newline(tmp_path):
    path = tmp_path / ".env"
    original = b"# existing settings\nCODE_ALONG_SECRET_KEY='keep this value'\nCODE_ALONG_DB_PASSWORD=keep_original\nCODE_ALONG_HTTPS_PORT=9443"
    path.write_bytes(original)
    prepare_environment(path)
    assert path.read_bytes().startswith(original + b"\n")
    values = assignments(path)
    assert values["CODE_ALONG_HTTPS_PORT"] == "9443"
    assert values["CODE_ALONG_DB_PASSWORD"] == "keep_original"
    assert values["CODE_ALONG_SECRET_KEY"] == "'keep this value'"


def test_concurrent_upgrades_choose_one_set_of_credentials(tmp_path):
    path = tmp_path / ".env"
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _: prepare_environment(path), range(12)))
    values = assignments(path)
    assert len(values) == len(SECRET_KEYS) + 1
    assert len(path.read_text().splitlines()) == len(values)
    assert not list(tmp_path.glob(".env-stage-*"))


@pytest.mark.parametrize(
    "text",
    [
        "CODE_ALONG_DB_PASSWORD=\n",
        "CODE_ALONG_DB_PASSWORD=''\n",
        "CODE_ALONG_DB_PASSWORD=first\nCODE_ALONG_DB_PASSWORD=second\n",
    ],
)
def test_ambiguous_existing_credentials_are_preserved_and_rejected(tmp_path, text):
    path = tmp_path / ".env"
    path.write_text(text)
    with pytest.raises(RuntimeError, match="ambiguous or empty"):
        prepare_environment(path)
    assert path.read_text() == text


def test_environment_symlink_does_not_modify_its_target(tmp_path):
    target = tmp_path / "target"
    target.write_text("keep")
    (tmp_path / ".env").symlink_to(target)
    with pytest.raises(RuntimeError, match="regular private file"):
        prepare_environment(tmp_path / ".env")
    assert target.read_text() == "keep"


def test_failed_atomic_replace_preserves_the_original_and_removes_stage(
    tmp_path, monkeypatch
):
    path = tmp_path / ".env"
    path.write_bytes(b"CODE_ALONG_DB_PASSWORD=original\n")

    def fail(*_args):
        raise OSError("fixture replacement failure")

    monkeypatch.setattr(os, "replace", fail)
    with pytest.raises(OSError, match="replacement failure"):
        prepare_environment(path)
    assert path.read_bytes() == b"CODE_ALONG_DB_PASSWORD=original\n"
    assert not list(tmp_path.glob(".env-stage-*"))

from pathlib import Path

import pytest

from tools.dev.postgres_cluster import (
    BIN_ENV,
    PostgresTestError,
    find_postgres_binaries,
    main,
    postgres_cluster,
)


def fake_toolset(root: Path, versions: dict[str, str] | None = None) -> Path:
    root.mkdir()
    for name in ("postgres", "initdb", "psql"):
        version = (versions or {}).get(name, "18.7")
        tool = root / name
        tool.write_text(f'#!/bin/sh\nprintf "%s\\n" "{name} (PostgreSQL) {version}"\n')
        tool.chmod(0o700)
    return root


def test_discovers_matching_tools_in_a_path_with_spaces(tmp_path):
    directory = fake_toolset(tmp_path / "native bin")
    binaries = find_postgres_binaries(directory)
    assert binaries.directory == directory.resolve()
    assert binaries.version == "18.7"


def test_explicit_directory_takes_priority_over_environment(tmp_path, monkeypatch):
    directory = fake_toolset(tmp_path / "bin")
    monkeypatch.setenv(BIN_ENV, str(tmp_path / "not installed"))
    assert find_postgres_binaries(directory).directory == directory


def test_environment_directory_is_respected(tmp_path, monkeypatch):
    directory = fake_toolset(tmp_path / "bin")
    monkeypatch.setenv(BIN_ENV, str(directory))
    assert find_postgres_binaries().version == "18.7"


def test_path_discovery_is_used_only_without_explicit_configuration(
    tmp_path, monkeypatch
):
    directory = fake_toolset(tmp_path / "bin")
    monkeypatch.delenv(BIN_ENV, raising=False)
    monkeypatch.setenv("PATH", str(directory))
    assert find_postgres_binaries().directory == directory


def test_missing_tools_fail_clearly_without_a_database(tmp_path):
    with pytest.raises(PostgresTestError, match="Missing executable"):
        find_postgres_binaries(tmp_path)


def test_missing_path_and_empty_configuration_fail_explicitly(monkeypatch):
    monkeypatch.delenv(BIN_ENV, raising=False)
    monkeypatch.setenv("PATH", "")
    with pytest.raises(PostgresTestError, match="Set CODE_ALONG_POSTGRES_BIN"):
        find_postgres_binaries()
    monkeypatch.setenv(BIN_ENV, "")
    with pytest.raises(PostgresTestError, match="must not be empty"):
        find_postgres_binaries()


@pytest.mark.parametrize("version", ["15.15", "17.7", "19.0", "18beta1", "18.8rc1"])
def test_rejects_older_newer_and_prerelease_binaries(tmp_path, version):
    directory = fake_toolset(tmp_path / "bin", {"postgres": version})
    with pytest.raises(PostgresTestError, match="Stable PostgreSQL 18"):
        find_postgres_binaries(directory)


def test_rejects_mixed_tool_versions(tmp_path):
    directory = fake_toolset(tmp_path / "bin", {"psql": "18.6"})
    with pytest.raises(PostgresTestError, match="versions must match"):
        find_postgres_binaries(directory)


def test_rejects_non_executable_tools(tmp_path):
    directory = fake_toolset(tmp_path / "bin")
    (directory / "initdb").chmod(0o600)
    with pytest.raises(PostgresTestError, match="Missing executable"):
        find_postgres_binaries(directory)


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf"), -float("inf")])
def test_rejects_timeout_before_starting_a_cluster(timeout):
    with pytest.raises(PostgresTestError, match="must be positive"):
        with postgres_cluster(startup_timeout=timeout):
            pytest.fail("Must not enter an invalid cluster context")


def test_cli_requires_a_command_without_starting_a_cluster():
    with pytest.raises(SystemExit) as result:
        main([])
    assert result.value.code == 2

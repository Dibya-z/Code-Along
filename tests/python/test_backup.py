import hashlib
import json
import stat
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest

from tools.ops import postgres_backup as backup


@pytest.fixture
def toolset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, dict[str, str], list[dict[str, Any]]]:
    directory = tmp_path / "trusted pg bin"
    directory.mkdir()
    for name in ("pg_dump", "pg_restore"):
        binary = directory / name
        binary.write_text("owned test tool")
        binary.chmod(0o700)
    env = {
        "PGHOST": "/private/owned-test-socket",
        "PGDATABASE": "application",
        "PGUSER": "backup_reader",
        "PGPASSWORD": "never-print-this-password",
        "PGSERVICE": "must-not-inherit",
        "PGOPTIONS": "must-not-inherit",
        "CODE_ALONG_SECRET_KEY": "unrelated-application-secret",
        "PATH": "/usr/bin",
    }
    calls: list[dict[str, Any]] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append({"args": args, **kwargs})
        if args[-1] == "--version":
            return subprocess.CompletedProcess(
                args, 0, f"{Path(args[0]).name} (PostgreSQL) 18.7\n", ""
            )
        if "--format=custom" in args:
            kwargs["stdout"].write(b"PGDMP\x00owned fake archive bytes")
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", run)
    return directory, env, calls


def test_new_backup_is_private_hashed_catalog_checked_and_contains_no_credentials(
    tmp_path: Path, toolset: Any
) -> None:
    tools, env, calls = toolset
    output = tmp_path / "private backup"
    manifest = backup.create_backup(output, pg_bin=tools, environ=env)
    archive = (output / backup.ARCHIVE).read_bytes()
    assert stat.S_IMODE(output.stat().st_mode) == 0o700
    for name in (backup.ARCHIVE, backup.MANIFEST):
        assert stat.S_IMODE((output / name).stat().st_mode) == 0o600
    assert manifest["bytes"] == len(archive)
    assert manifest["sha256"] == hashlib.sha256(archive).hexdigest()
    assert backup.verify_backup(output, pg_bin=tools, environ=env) == manifest
    for call in calls:
        assert env["PGPASSWORD"] not in str(call["args"])
        assert "PGSERVICE" not in call["env"]
        assert "CODE_ALONG_SECRET_KEY" not in call["env"]
        if "--format=custom" in call["args"]:
            assert call["env"]["PGPASSWORD"] == env["PGPASSWORD"]
            assert call["env"]["PGOPTIONS"] == "-c default_transaction_read_only=on"
            assert call["stderr"] == subprocess.DEVNULL
            assert "--no-password" in call["args"]
        else:
            assert not any(key.startswith("PG") for key in call["env"])
    assert env["PGPASSWORD"] not in (output / backup.MANIFEST).read_text()
    assert env["PGUSER"] not in (output / backup.MANIFEST).read_text()


def test_existing_output_and_symlink_are_never_reused_or_modified(
    tmp_path: Path, toolset: Any
) -> None:
    tools, env, calls = toolset
    existing = tmp_path / "existing"
    existing.mkdir()
    sentinel = existing / "keep"
    sentinel.write_bytes(b"original")
    link = tmp_path / "link"
    link.symlink_to(existing, target_is_directory=True)
    for output in (existing, link):
        with pytest.raises(backup.BackupError):
            backup.create_backup(output, pg_bin=tools, environ=env)
    assert sentinel.read_bytes() == b"original"
    assert list(existing.iterdir()) == [sentinel]
    assert not any("--format=custom" in call["args"] for call in calls)


@pytest.mark.parametrize(
    "change", ["archive", "manifest-name", "manifest-bool", "symlink", "permissions"]
)
def test_verification_rejects_tampering_before_catalog_tool(
    tmp_path: Path, toolset: Any, change: str
) -> None:
    tools, env, calls = toolset
    output = tmp_path / "backup"
    backup.create_backup(output, pg_bin=tools, environ=env)
    calls.clear()
    if change == "archive":
        with (output / backup.ARCHIVE).open("ab") as stream:
            stream.write(b"changed")
    elif change.startswith("manifest"):
        path = output / backup.MANIFEST
        manifest = json.loads(path.read_text())
        manifest["archive" if change == "manifest-name" else "bytes"] = (
            "../elsewhere" if change == "manifest-name" else True
        )
        path.write_text(json.dumps(manifest))
    elif change == "symlink":
        original = output / backup.ARCHIVE
        target = tmp_path / "private-copy"
        original.rename(target)
        original.symlink_to(target)
    else:
        (output / backup.ARCHIVE).chmod(0o644)
    with pytest.raises(backup.BackupError):
        backup.verify_backup(output, pg_bin=tools, environ=env)
    assert calls == []


@pytest.mark.parametrize("failure", ["exit", "timeout", "oserror", "catalog"])
def test_failed_backup_has_no_completed_manifest_and_cli_never_reflects_tool_diagnostics(
    tmp_path: Path,
    toolset: Any,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: str,
) -> None:
    tools, env, _ = toolset
    original = subprocess.run

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        if args[-1] == "--version":
            return cast(subprocess.CompletedProcess[str], original(args, **kwargs))
        if failure == "timeout":
            raise subprocess.TimeoutExpired([env["PGPASSWORD"]], 1)
        if failure == "oserror":
            raise OSError(env["PGPASSWORD"])
        if failure == "exit" or "--list" in args:
            return subprocess.CompletedProcess(args, 1, "", env["PGPASSWORD"])
        return cast(subprocess.CompletedProcess[str], original(args, **kwargs))

    monkeypatch.setattr(subprocess, "run", run)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    output = tmp_path / "partial"
    assert backup.main(["--pg-bin", str(tools), "backup", "--output", str(output)]) == 1
    captured = capsys.readouterr()
    assert env["PGPASSWORD"] not in captured.out + captured.err
    assert "Traceback" not in captured.err
    assert not (output / backup.MANIFEST).exists()
    assert stat.S_IMODE(output.stat().st_mode) == 0o700


@pytest.mark.parametrize(
    "override",
    [
        {"PGDATABASE": "postgresql://sensitive"},
        {"PGHOST": ""},
        {"PGUSER": ""},
        {"PGPORT": "0"},
        {"PGHOST": "db.example.test", "PGSSLMODE": "disable"},
    ],
)
def test_invalid_or_insecure_connection_inputs_fail_before_creating_output(
    tmp_path: Path, toolset: Any, override: dict[str, str]
) -> None:
    tools, env, calls = toolset
    output = tmp_path / "not-created"
    with pytest.raises(backup.BackupError):
        backup.create_backup(output, pg_bin=tools, environ={**env, **override})
    assert not output.exists()
    assert calls == []


def test_remote_backup_defaults_to_verified_tls_and_all_commands_are_noninteractive(
    tmp_path: Path, toolset: Any
) -> None:
    tools, env, calls = toolset
    backup.create_backup(
        tmp_path / "remote",
        pg_bin=tools,
        environ={**env, "PGHOST": "db.example.test", "PGGSSENCMODE": "require"},
    )
    dump = next(call for call in calls if "--format=custom" in call["args"])
    assert dump["env"]["PGSSLMODE"] == "verify-full"
    assert dump["env"]["PGCONNECT_TIMEOUT"] == "5"
    assert dump["env"]["PGGSSENCMODE"] == "disable"


@pytest.mark.parametrize(
    "host",
    [
        "/owned/socket,db.example.test",
        "db.example.test,/owned/socket",
        "/owned/socket, /another/socket",
        "db.example.test,db2.example.test",
        " /owned/socket",
        "/owned/socket ",
        " db.example.test",
        "db.example.test ",
        "/owned/sock\net",
        "/owned/sock\x85et",
        "/owned/socket\x00",
        "db.example.test\t",
        "db\x7f.example.test",
        "postgresql://db.example.test",
        "db.example.test:5432",
        "@abstract-socket",
    ],
)
def test_host_must_be_one_unambiguous_socket_directory_or_hostname_before_any_tool_or_output(
    tmp_path: Path,
    toolset: Any,
    host: str,
) -> None:
    tools, env, calls = toolset
    output = tmp_path / "forbidden"
    with pytest.raises(backup.BackupError):
        backup.create_backup(output, pg_bin=tools, environ={**env, "PGHOST": host})
    assert not output.exists()
    assert calls == []


@pytest.mark.parametrize(
    "host, expected_mode",
    [
        ("/private/owned socket", "disable"),
        ("db", "verify-full"),
        ("db.example.test", "verify-full"),
        ("127.0.0.1", "verify-full"),
        ("::1", "verify-full"),
    ],
)
def test_single_local_paths_and_single_remote_hosts_remain_supported(
    tmp_path: Path,
    toolset: Any,
    host: str,
    expected_mode: str,
) -> None:
    tools, env, calls = toolset
    backup.create_backup(
        tmp_path / "valid", pg_bin=tools, environ={**env, "PGHOST": host}
    )
    dump = next(call for call in calls if "--format=custom" in call["args"])
    assert dump["env"]["PGSSLMODE"] == expected_mode


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan"), 3601, True])
def test_invalid_timeouts_do_not_create_a_backup(
    tmp_path: Path, toolset: Any, timeout: float
) -> None:
    tools, env, calls = toolset
    with pytest.raises(backup.BackupError):
        backup.create_backup(
            tmp_path / "invalid", pg_bin=tools, environ=env, timeout=timeout
        )
    assert calls == []


def test_mixed_versions_fail_before_creating_output(
    tmp_path: Path, toolset: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    tools, env, _ = toolset
    original = subprocess.run

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        value = cast(subprocess.CompletedProcess[str], original(args, **kwargs))
        if Path(args[0]).name == "pg_restore":
            value.stdout = "pg_restore (PostgreSQL) 18.6\n"
        return value

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(backup.BackupError, match="versions must match"):
        backup.create_backup(tmp_path / "mixed", pg_bin=tools, environ=env)
    assert not (tmp_path / "mixed").exists()


def test_unknown_restore_command_and_bad_arguments_are_rejected_without_reflecting_values(
    capsys: pytest.CaptureFixture[str],
) -> None:
    for arguments in (
        ["restore", "never-print-credential"],
        ["--timeout", "never-print-credential", "verify", "/unused"],
    ):
        with pytest.raises(SystemExit) as stopped:
            backup.main(arguments)
        assert stopped.value.code == 2
        assert "never-print-credential" not in capsys.readouterr().err

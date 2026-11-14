"""Private PostgreSQL 18 backups; deliberately provides no restore/delete command.

Connection settings come only from explicit PG* environment variables. Verify
checks archive bytes and the PostgreSQL table of contents, not restore success.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn

FORMAT = "code-along-postgres-backup"
ARCHIVE = "database.dump"
MANIFEST = "manifest.json"
_IDENTIFIER = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}\Z")
_CONNECTION_KEYS = (
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
    "PGSSLMODE",
    "PGSSLROOTCERT",
    "PGSSLCERT",
    "PGSSLKEY",
    "PGSSLCRL",
    "PGSSLMINPROTOCOLVERSION",
    "PGCHANNELBINDING",
)


class BackupError(RuntimeError):
    """A bounded operator-facing failure, without SQL or connection details."""


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(2, "Invalid backup command arguments; see --help.\n")


def _environment(environ: Mapping[str, str]) -> dict[str, str]:
    # Client tools need no application secrets or ambient PG service/options.
    allowed = (
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TZ",
        "TMPDIR",
        "SYSTEMROOT",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    )
    return {name: environ[name] for name in allowed if name in environ}


def _timeout(value: float) -> None:
    if isinstance(value, bool) or not math.isfinite(value) or not 0 < value <= 3600:
        raise BackupError("Timeout must be positive and at most 3600 seconds.")


def _local_socket(host: str) -> bool:
    # libpq accepts comma-separated fallback hosts even when the first entry is
    # a socket path. Classify only an explicit single destination before choosing TLS.
    if (
        not host
        or host != host.strip()
        or "," in host
        or any(not character.isprintable() for character in host)
    ):
        raise BackupError("PGHOST must identify one socket directory or hostname/IP.")
    if host.startswith("/"):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or not all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in host.split(".")
        ):
            raise BackupError(
                "PGHOST must identify one socket directory or hostname/IP."
            ) from None
    return False


def _tools(pg_bin: Path | None, environ: Mapping[str, str]) -> tuple[Path, Path, str]:
    configured = pg_bin or environ.get("CODE_ALONG_POSTGRES_BIN")
    if configured:
        directory = Path(configured).expanduser().resolve()
    else:
        discovered = shutil.which("pg_dump", path=environ.get("PATH", ""))
        if not discovered:
            raise BackupError(
                "Configure a trusted PostgreSQL 18 client tool directory."
            )
        directory = Path(discovered).resolve().parent
    versions = []
    for name in ("pg_dump", "pg_restore"):
        binary = directory / name
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise BackupError(
                "Matching executable PostgreSQL 18 client tools are required."
            )
        try:
            result = subprocess.run(
                [str(binary), "--version"],
                env=_environment(environ),
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise BackupError("PostgreSQL client version check failed.") from None
        match = re.fullmatch(
            rf"{name} \(PostgreSQL\) (18\.\d+)(?: [^\n]*)?\n?", result.stdout
        )
        if result.returncode or not match:
            raise BackupError("Stable PostgreSQL 18 client tools are required.")
        versions.append(match[1])
    if versions[0] != versions[1]:
        raise BackupError("PostgreSQL client versions must match.")
    return directory / "pg_dump", directory / "pg_restore", versions[0]


def _private(path: Path, *, directory: bool = False) -> None:
    info = path.lstat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise BackupError(
            "Backup paths must be owner-private regular files and directories."
        )


def _digest(path: Path) -> tuple[int, str]:
    size, digest = 0, hashlib.sha256()
    with path.open("rb") as stream:
        if stream.read(5) != b"PGDMP":
            raise BackupError("A PostgreSQL custom archive is required.")
        stream.seek(0)
        while chunk := stream.read(65536):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _catalog(
    tool: Path, archive: Path, environ: Mapping[str, str], timeout: float
) -> None:
    result = subprocess.run(
        [str(tool), "--list", str(archive)],
        env=_environment(environ),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )
    if result.returncode:
        raise BackupError("PostgreSQL archive catalog validation failed.")


def create_backup(
    output: Path,
    *,
    pg_bin: Path | None = None,
    environ: Mapping[str, str] | None = None,
    timeout: float = 300,
) -> dict[str, Any]:
    """Write only to a new explicit directory. Failure leaves private partial output."""
    env = os.environ if environ is None else environ
    try:
        _timeout(timeout)
        if os.name != "posix" or not output.is_absolute():
            raise BackupError("Use an absolute new backup directory on macOS or Linux.")
        if not env.get("PGHOST") or not all(
            _IDENTIFIER.fullmatch(env.get(key, "")) for key in ("PGDATABASE", "PGUSER")
        ):
            raise BackupError("Explicit PGHOST, PGDATABASE and PGUSER are required.")
        port = env.get("PGPORT", "5432")
        if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
            raise BackupError("PGPORT must be a valid port number.")
        local = _local_socket(env["PGHOST"])
        sslmode = env.get("PGSSLMODE", "disable" if local else "verify-full")
        if sslmode not in ("disable", "verify-full") or (
            sslmode != "verify-full" and not local
        ):
            raise BackupError("TCP backups require PGSSLMODE=verify-full.")
        dump, restore, version = _tools(pg_bin, env)
        connection = {
            **_environment(env),
            **{k: env[k] for k in _CONNECTION_KEYS if k in env},
        }
        connection.update(
            PGCONNECT_TIMEOUT="5",
            PGAPPNAME="code-along-backup",
            PGOPTIONS="-c default_transaction_read_only=on",
            PGSSLMODE=sslmode,
            PGGSSENCMODE="disable",
        )
        output.mkdir(mode=0o700)  # Exclusive: never reuse an existing path.
        _private(output, directory=True)
        archive = output / ARCHIVE
        descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            result = subprocess.run(
                [
                    str(dump),
                    "--format=custom",
                    "--no-password",
                    "--no-acl",
                    "--lock-wait-timeout=10s",
                ],
                env=connection,
                stdout=stream,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
            )
            if result.returncode:
                raise BackupError(
                    "PostgreSQL backup failed; private partial output may remain."
                )
            stream.flush()
            os.fsync(stream.fileno())
        _private(archive)
        size, digest = _digest(archive)
        _catalog(restore, archive, env, timeout)
        manifest = {
            "format": FORMAT,
            "version": 1,
            "created_at": datetime.now(UTC).isoformat(),
            "postgres_version": version,
            "archive": ARCHIVE,
            "bytes": size,
            "sha256": digest,
        }
        descriptor = os.open(
            output / MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        with os.fdopen(descriptor, "w") as stream:
            json.dump(manifest, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        return manifest
    except BackupError:
        raise
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise BackupError(
            "Backup could not complete; private partial output may remain."
        ) from None


def verify_backup(
    directory: Path,
    *,
    pg_bin: Path | None = None,
    environ: Mapping[str, str] | None = None,
    timeout: float = 300,
) -> dict[str, Any]:
    """Read local bytes/catalog only; never connect to or modify a database."""
    env = os.environ if environ is None else environ
    try:
        _timeout(timeout)
        if os.name != "posix":
            raise BackupError("Backup verification requires macOS or Linux.")
        _private(directory, directory=True)
        manifest_path, archive = directory / MANIFEST, directory / ARCHIVE
        _private(manifest_path)
        _private(archive)
        with manifest_path.open("rb") as stream:
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise BackupError("Invalid backup manifest.")
        manifest = json.loads(raw)
        if (
            not isinstance(manifest, dict)
            or set(manifest)
            != {
                "format",
                "version",
                "created_at",
                "postgres_version",
                "archive",
                "bytes",
                "sha256",
            }
            or manifest["format"] != FORMAT
            or type(manifest["version"]) is not int
            or manifest["version"] != 1
            or manifest["archive"] != ARCHIVE
            or type(manifest["bytes"]) is not int
            or manifest["bytes"] <= 5
            or not isinstance(manifest["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", manifest["sha256"])
            or not isinstance(manifest["postgres_version"], str)
            or not re.fullmatch(r"18\.\d+", manifest["postgres_version"])
            or not isinstance(manifest["created_at"], str)
            or datetime.fromisoformat(manifest["created_at"]).utcoffset() is None
        ):
            raise BackupError("Invalid backup manifest.")
        if _digest(archive) != (manifest["bytes"], manifest["sha256"]):
            raise BackupError("Backup archive integrity check failed.")
        _, restore, _ = _tools(pg_bin, env)
        _catalog(restore, archive, env, timeout)
        return manifest
    except BackupError:
        raise
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, RecursionError):
        raise BackupError("Backup verification failed.") from None


def main(argv: Sequence[str] | None = None) -> int:
    parser = _Parser(description=__doc__)
    parser.add_argument("--pg-bin", type=Path)
    parser.add_argument("--timeout", type=float, default=300)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup")
    backup.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("directory", type=Path)
    args = parser.parse_args(argv)
    try:
        operation = create_backup if args.command == "backup" else verify_backup
        operation(
            args.output if args.command == "backup" else args.directory,
            pg_bin=args.pg_bin,
            timeout=args.timeout,
        )
    except BackupError as error:
        print(str(error), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(
            "Backup operation interrupted; private partial output may remain.",
            file=sys.stderr,
        )
        return 130
    print(
        "Backup created; bytes and catalog verified. Restore not exercised."
        if args.command == "backup"
        else "Backup bytes and catalog verified; restore not exercised."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

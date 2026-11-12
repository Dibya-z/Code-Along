"""Disposable PostgreSQL 18 clusters for trusted local development tests.

No external database URL is accepted. Each context owns one private Unix-socket
cluster; this is not an application database or a production service launcher.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

BIN_ENV = "CODE_ALONG_POSTGRES_BIN"
TEST_USER = "code_along_test"
TEST_DATABASE = "postgres"
TEST_PORT = "5432"


class PostgresTestError(RuntimeError):
    """A prerequisite or owned-cluster operation failed."""


def _clean_environment() -> dict[str, str]:
    # Never inherit an external database/service/password/options configuration.
    return {key: value for key, value in os.environ.items() if not key.startswith("PG")}


@dataclass(frozen=True)
class PostgresBinaries:
    directory: Path
    version: str


def find_postgres_binaries(directory: Path | None = None) -> PostgresBinaries:
    """Validate a matching, stable PostgreSQL 18 toolset before creating data."""
    if os.name != "posix":
        raise PostgresTestError("The native test harness requires macOS or Linux.")
    if directory is None:
        configured = os.environ.get(BIN_ENV)
        if configured is not None:
            if not configured.strip():
                raise PostgresTestError(f"{BIN_ENV} must not be empty.")
            directory = Path(configured)
        else:
            postgres = shutil.which("postgres")
            if postgres is None:
                raise PostgresTestError(
                    f"Set {BIN_ENV} to a PostgreSQL 18 bin directory."
                )
            directory = Path(postgres).parent
    directory = directory.expanduser().resolve()

    versions = []
    for name in ("postgres", "initdb", "psql"):
        binary = directory / name
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise PostgresTestError(f"Missing executable PostgreSQL tool: {name}.")
        try:
            result = subprocess.run(
                [str(binary), "--version"],
                env=_clean_environment(),
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PostgresTestError(
                f"Could not inspect PostgreSQL tool: {name}."
            ) from error
        match = re.search(r"\(PostgreSQL\) (18\.\d+)(?:\s|$)", result.stdout)
        if result.returncode != 0 or match is None:
            raise PostgresTestError(f"Stable PostgreSQL 18 is required for {name}.")
        versions.append(match.group(1))
    if len(set(versions)) != 1:
        raise PostgresTestError("postgres, initdb and psql versions must match.")
    return PostgresBinaries(directory, versions[0])


@dataclass(frozen=True)
class PostgresCluster:
    binaries: PostgresBinaries
    directory: Path
    socket_directory: Path
    process: subprocess.Popen[bytes] = field(repr=False)

    def environment(self) -> dict[str, str]:
        """Return a child environment scoped to this cluster, not the caller's DB."""
        return {
            **_clean_environment(),
            "PGHOST": str(self.socket_directory),
            "PGPORT": TEST_PORT,
            "PGUSER": TEST_USER,
            "PGDATABASE": TEST_DATABASE,
            "PGCONNECT_TIMEOUT": "2",
        }

    def sql(self, statement: str) -> str:
        """Run trusted test SQL; diagnostics never echo the statement or its data."""
        try:
            result = subprocess.run(
                [
                    str(self.binaries.directory / "psql"),
                    "--no-psqlrc",
                    "--no-password",
                    "--tuples-only",
                    "--no-align",
                    "--set=ON_ERROR_STOP=1",
                    "--command",
                    statement,
                ],
                env=self.environment(),
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            # TimeoutExpired includes argv (and SQL); do not chain that diagnostic.
            raise PostgresTestError(
                "PostgreSQL test query could not complete."
            ) from None
        if result.returncode != 0:
            raise PostgresTestError("PostgreSQL test query failed.")
        return result.stdout.strip()


def _stop_owned_process(
    process: subprocess.Popen[bytes],
    *,
    stop_signal: signal.Signals = signal.SIGINT,
    whole_group: bool = False,
) -> None:
    if process.poll() is not None:
        return
    try:
        # SIGINT is PostgreSQL's fast shutdown: rollback active work and exit.
        if whole_group:
            os.killpg(process.pid, stop_signal)
        else:
            process.send_signal(stop_signal)
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        # start_new_session below gives this server its own process group.
        # Never use a system-wide kill or target a PID from an external file.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    except ProcessLookupError:
        process.wait(timeout=5)


def _wait_until_ready(cluster: PostgresCluster, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cluster.process.poll() is not None:
            raise PostgresTestError("Owned PostgreSQL server exited during startup.")
        try:
            if cluster.sql("SELECT 1") == "1":
                return
        except PostgresTestError:
            time.sleep(0.05)
    raise PostgresTestError("Owned PostgreSQL server did not become ready in time.")


@contextmanager
def postgres_cluster(
    directory: Path | None = None, *, startup_timeout: float = 15
) -> Iterator[PostgresCluster]:
    """Create, use and stop one owned cluster, including on test exceptions."""
    if not math.isfinite(startup_timeout) or startup_timeout <= 0:
        raise PostgresTestError("Startup timeout must be positive and finite.")
    binaries = find_postgres_binaries(directory)
    # A short path avoids the Unix socket pathname limit on macOS. mkdtemp
    # creates the directory atomically with private owner-only permissions.
    with tempfile.TemporaryDirectory(prefix="ca-pg18-", dir="/tmp") as temporary:
        root = Path(temporary)
        data = root / "data"
        sockets = root / "socket"
        sockets.mkdir(mode=0o700)
        try:
            result = subprocess.run(
                [
                    str(binaries.directory / "initdb"),
                    "--pgdata",
                    str(data),
                    "--username",
                    TEST_USER,
                    "--encoding=UTF8",
                    "--locale=C",
                    "--auth-local=trust",
                    "--auth-host=reject",
                ],
                env=_clean_environment(),
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PostgresTestError(
                "Temporary PostgreSQL initialization failed."
            ) from error
        if result.returncode != 0:
            raise PostgresTestError("Temporary PostgreSQL initialization failed.")

        with (root / "server.log").open("xb") as log:
            process = subprocess.Popen(
                [
                    str(binaries.directory / "postgres"),
                    "-D",
                    str(data),
                    "-k",
                    str(sockets),
                    "-c",
                    "listen_addresses=",
                    "-c",
                    f"port={TEST_PORT}",
                    "-c",
                    "unix_socket_permissions=0700",
                    "-c",
                    "shared_buffers=16MB",
                    "-c",
                    "max_connections=10",
                    "-c",
                    "fsync=on",
                    "-c",
                    "synchronous_commit=on",
                    "-c",
                    "full_page_writes=on",
                    "-c",
                    "log_min_error_statement=panic",
                    "-c",
                    "log_error_verbosity=terse",
                ],
                env=_clean_environment(),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            cluster = PostgresCluster(binaries, root, sockets, process)
            try:
                _wait_until_ready(cluster, startup_timeout)
                yield cluster
            finally:
                _stop_owned_process(process)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pg-bin", type=Path, help=f"Defaults to {BIN_ENV}, then PATH."
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("Supply a trusted test command after --.")

    interrupted_by = signal.SIGINT

    def interrupt(signum: int, _frame: object) -> None:
        nonlocal interrupted_by
        interrupted_by = signal.Signals(signum)
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        with postgres_cluster(args.pg_bin) as cluster:
            # No shell interpolation; connection values exist only in the child.
            child = subprocess.Popen(
                command, env=cluster.environment(), start_new_session=True
            )
            try:
                returncode = child.wait()
            finally:
                _stop_owned_process(child, stop_signal=signal.SIGTERM, whole_group=True)
        return returncode if returncode >= 0 else 128 - returncode
    except KeyboardInterrupt:
        return 128 + interrupted_by
    except (PostgresTestError, OSError) as error:
        print(f"PostgreSQL test harness: {error}", file=sys.stderr)
        return 2
    finally:
        signal.signal(signal.SIGTERM, previous)


if __name__ == "__main__":
    raise SystemExit(main())

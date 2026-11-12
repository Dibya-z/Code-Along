# Disposable PostgreSQL 18 tests

M0.4a provides a native test-cluster harness. It creates no application database/schema and does not implement the checkpoint writer. The separate [M0.4b storage proof](../architecture/checkpoint-persistence-proof.md) now tests binary persistence and atomic receipts; the completed M0.4c transport/restart evidence is linked below.

## Prerequisites and commands

Use the repository's pinned Python/uv environment and an installed **matching stable PostgreSQL 18** toolset containing executable `postgres`, `initdb` and `psql`. All three must report the same patch release. macOS arm64 with PostgreSQL **18.7** is verified; this POSIX harness also targets Linux but Linux has not been tested. Windows support is not claimed. Docker is not needed for this harness; the full Compose development stack remains a later task.

From the Code Along repository root, set an absolute path to your trusted installation:

```sh
export UV_CACHE_DIR="$PWD/.uv-cache"
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
uv sync --locked --no-python-downloads
uv run --locked --offline python -m pytest -q
```

The path above is a placeholder: do not use the reference investigation's PostgreSQL 15 binaries. Explicit `--pg-bin` takes precedence over the environment; absent both, the harness looks for `postgres` on PATH. Missing, mixed, older, newer-major or prerelease tools fail before a data directory is initialized.

Use `python -m pytest` so repository tooling namespaces are importable without installing the root project as a package or changing PYTHONPATH.

For prerequisite checks without starting a server:

```sh
uv run --locked --offline python -m pytest tests/python -m 'not postgres' -q
```

This deliberately deselects integration tests and is not a substitute for the full command. The `postgres` marker is registered in pyproject.toml. Integration tests fail clearly when prerequisites are missing; they are not silently skipped.

To run a trusted command with connection variables pointing at a fresh cluster:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  "$CODE_ALONG_POSTGRES_BIN/psql" -X -w -At -c "SELECT current_setting('server_version')"
```

This prints the actual server version and stops/removes the cluster afterward. The command runs without a shell; its ordinary exit status is preserved, including failure. SIGINT returns 130 and SIGTERM returns 143 after cleanup. Child commands must be trusted foreground test programs, not daemon launchers or learner code. They can produce their own output; the harness is not a command sandbox.

The Python context manager is also available to test fixtures:

```python
from tools.dev.postgres_cluster import postgres_cluster

with postgres_cluster() as cluster:
    assert cluster.sql("SELECT 1") == "1"
    # cluster.environment() is a fresh child environment for this cluster.
```

## Isolation and lifecycle

Each run initializes an owner-only random `/tmp/ca-pg18-*` directory and a private Unix socket. TCP listen addresses are empty. Local trust authentication is restricted by that private filesystem directory; TCP host authentication is reject. The bootstrap test role has database administration rights only in this disposable cluster. Do not use this setup as production authentication or to execute hostile SQL/Python.

The harness removes inherited PG* connection/password/service/options variables in child environments, then supplies its own host/user/database/port. It never accepts an external database URL, uses a user's psqlrc, resets a shared database or changes parent environment variables. It uses no system service manager and no global installation.

`fsync`, `synchronous_commit` and `full_page_writes` are explicitly on. Shared buffers and max connections are small test settings, not performance recommendations. The database uses UTF-8 with C locale. SQL errors and timeouts raised by the helper do not echo the query; PostgreSQL logs stay private and are deleted with the run.

Readiness polling, SQL calls, version probes and shutdown waits are bounded. Normal completion, startup failure, body exceptions and handled CLI interrupts stop owned processes and remove the temporary data/log/socket directories. PostgreSQL receives fast shutdown; timed-out owned processes have a process-group kill fallback. The harness never uses a global pkill or enumerates/deletes other databases.

Hard-killing the owner with SIGKILL or losing power bypasses Python cleanup. Such a run can leave its private process/directory behind. Identify that specific failed run and use the matching installation's pg_ctl on its data directory before removing it; do not stop processes or delete directories belonging to another run. Detached child daemons are outside the foreground-command contract.

## Verified native installation

No PostgreSQL 18 installation was initially present. Validation used an isolated source build outside both project repositories. Obtain a trusted binary distribution or build from the [official source directory](https://www.postgresql.org/ftp/source/v18.7/), following the [official Make installation guide](https://www.postgresql.org/docs/18/install-make.html).

The observed build used:

- Source: `https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2`.
- Published and locally verified SHA-256: `441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd`.
- Clang and Make on macOS arm64; a private temporary installation prefix.

After acquiring and verifying that source archive, the configuration/build steps used were:

```sh
# Run inside the extracted postgresql-18.7 source directory.
# Choose an absolute writable prefix outside tracked application source.
CC=clang ./configure --prefix="$CODE_ALONG_PG_PREFIX" \
  --without-icu --without-readline --without-zlib
make -j4
make install
export CODE_ALONG_POSTGRES_BIN="$CODE_ALONG_PG_PREFIX/bin"
```

Set CODE_ALONG_PG_PREFIX to your chosen private installation location before those commands. The reduced optional-library configuration is for this local proof, not a proposed production image. There is no dependency on the temporary build path used in this session; it may disappear and must be replaced by a trusted PostgreSQL 18 installation if so. No archive, compiled binary, cluster data or build logs belong in Git.

## Evidence and remaining work

The M0.4a suite verifies version/discovery failures, actual server settings/private permissions, commit/rollback, separation of two simultaneous clusters, SQL diagnostic redaction, cleanup on body/startup failure, child exit propagation and SIGTERM cleanup of both child and database. Commands and real server execution were verified with PostgreSQL 18.7.

These are database-harness tests. They do not establish CRDT convergence, checkpoint idempotency, atomic receipt transactions, stale-save protection, restart recovery or authorization. The separate M0.4b suite now covers storage transactions/CAS/idempotency; M0.4c now adds provider/restart fixture evidence as described below; full product authorization remains M1/M3. There is no application URL or persistent local service after the tests finish. See [PostgreSQL initdb](https://www.postgresql.org/docs/18/app-initdb.html) and [connection settings](https://www.postgresql.org/docs/18/runtime-config-connection.html) for native server behavior.

## Additional M0 integration gates

The Hocuspocus transport suite runs through a **separate fresh cluster**, because each explicit integration suite creates its own fixture schema/role:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:transport
```

The Python suite now has 29 cases and additionally requires Node plus the installed pnpm workspace for `test_checkpoint_recovery.py`. That case saves a real binary checkpoint/receipt, requests immediate shutdown of its owned PostgreSQL postmaster, starts the same owned data directory for WAL recovery, and verifies exact source/idempotency from a fresh Node process. It cleans both process lifetimes/data on success or failure. It does not kill a shared database or claim power-loss/backup/HA coverage. See the [M0 record](../architecture/m0-validation.md).

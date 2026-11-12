# Binary checkpoint persistence proof (M0.4b)

Status: implemented and tested against disposable PostgreSQL 18.7. This is a storage component/proof, not a running collaboration service. Production authentication remains M1/M3 work. The subsequent M0 transport/restart proof is recorded below. Read the [wire contract](../protocols/collaboration-checkpoints.md) and [database harness setup](../operations/postgres-tests.md).

## Ownership and interfaces

`apps/collaboration/src/persistence/checkpoint-store.ts` exposes:

| Method                    | Behavior                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(scope, seed)` | Validate a server-provided seed; atomically insert only if no state exists, otherwise return the winning canonical binary. It never merges two competing plaintext-derived seeds. |
| `load(scope)`             | Return a defensive copy of the stored binary, revision and digest after checking current metadata/generation and checksum.                                                        |
| `saveState(scope, bytes)` | Queue an autosave, merge against current storage and commit a new revision without a client receipt.                                                                              |
| `saveCheckpoint(frame)`   | Parse the strict v1 envelope, freeze input identity/bytes, queue it and return the correlated receipt only after COMMIT succeeds.                                                 |

These methods do not authorize users. The caller must bind the authenticated document/generation and current write lease before every invocation. Session/checkpoint UUIDs are correlation/idempotency keys, not permissions. The fixture role is a database boundary, not learner authorization.

The component currently targets `checkpoint_proof` tables in a **test-only fixture**. It executes no DDL or product metadata mutations. Django will own the production migrations, retention/generation model and table mapping. Do not deploy the fixture schema/role as the product schema or treat its metadata reset tests as the production archival policy.

## Persistence algorithm

1. Copy scope and incoming bytes before asynchronous work. A per-document queue serializes explicit checkpoints, autosaves and initialization within one store; failed work cannot block subsequent tasks indefinitely.
2. Acquire one pool client for the complete transaction; start READ COMMITTED, set local statement/lock timeouts and `synchronous_commit=on`. The owning application must configure bounded pool connection acquisition and idle error handling. The proof uses a 1-second connection timeout and a small pool.
3. Read authoritative generation and current binary state/revision. Verify the stored checksum. For a retained checkpoint key, compare the server-computed incoming-byte hash and captured counter. Identical retries return the original receipt, even if newer source exists; changed bytes/counter produce `checkpoint_conflict`.
4. Merge current binary and incoming update in a throwaway Y.Doc, validate the resulting text/schema/resource bounds, and capture immutable encoded bytes/digest. Never reseed a reconnect from plaintext or overwrite a current state with a delayed full snapshot.
5. Update using `WHERE document_id/generation/revision = expected`, incrementing the revision. A lost compare-and-swap retries from a fresh transaction/current state, up to eight attempts. The test forces two independent writers to block at UPDATE with the same old revision, then verifies both edits survive.
6. Insert the receipt in the **same transaction** as the new state. Commit before returning either result. Deferred trigger failures during COMMIT roll back both records; there is no pre-commit acknowledgment.

The idempotency key is document/generation/client-session/checkpoint ID. The submitted-byte hash differs conceptually from the committed merged-state hash. A receipt stores both required provenance values, but the wire response carries the committed-state digest. Receipt pruning is not implemented by this writer; an administrative test deletes retained receipts and confirms that a retried full state merges safely as a fresh checkpoint.

All SQL parameters are bound. Revisions are cast to text at the database boundary; bigint values above JavaScript's exact-number range stay decimal strings. The receipt fixture timestamp is `recorded_at` inside the transaction, not a claim of an exact database commit timestamp.

All driver failures become bounded `storage_unavailable` errors without SQL/data/driver causes. Active client errors mark that connection for disposal; rollback/release cleanup is attempted without returning a receipt. A lost COMMIT response can still mean the database committed: callers retain the immutable request and retry rather than infer either outcome. The current tests discard a successful receipt and retry; actual transport response loss/restart is still a later gate.

[PostgreSQL READ COMMITTED behavior](https://www.postgresql.org/docs/18/transaction-iso.html) explains re-evaluation of an UPDATE predicate after a competing writer. [node-postgres transactions](https://node-postgres.com/features/transactions) require one checked-out client for the entire transaction.

## Binary schema and proof-stage limits

The pinned Yjs 13.6.33 validator permits only plaintext structures under `source`, deletion/GC structures and no unresolved causal fragments. Maps, rich formatting, embeds and extra populated roots are rejected. It enforces:

- 128 KiB UTF-8 source text;
- 1 MiB encoded binary state (the shared v1 envelope limit);
- 16,384 decoded structures and an 8 MiB aggregate structure span;
- 32 pending writes per store, eight CAS attempts, 3-second SQL statement and 2-second lock timeouts.

These limits bound this proof; they are not measured classroom capacity or a hostile-decoder sandbox. Pool/transport/process quotas and application admission remain necessary. A future durable board needs its own schema. The validation uses the pinned Yjs `pendingStructs`/`pendingDs` internal fields to reject unresolved fragments; upgrades must rerun compatibility tests. Binary integrity and schema checks do not establish authorship, application permissions or a trusted grade.

## Reproduce the tests

After the documented Node/Python/PostgreSQL prerequisites and frozen install:

```sh
export COREPACK_HOME="$PWD/.pnpm-store/corepack"
export UV_CACHE_DIR="$PWD/.uv-cache"
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:integration
uv run --locked --offline python -m pytest -q
```

The regular JavaScript command runs 133 contract/binary-validation tests and explicitly excludes native-database integration files. The separate integration command runs 20 tests and fails if the private harness prerequisites are absent; nothing is silently skipped. Python has 28 harness tests. Both the working tree and a clean cached workspace passed the JavaScript/integration checks, including native Node import without a TS runtime loader. Linux/browser runtimes have not been tested.

The integration fixture creates a login role with SELECT metadata, SELECT/INSERT/UPDATE state, and SELECT/INSERT receipt grants. Tests verify that it cannot create product tables, mutate metadata or delete receipts. The native cluster is private, temporary and has no TCP listener; this trust-authenticated test role is not a production credential design.

## Evidence boundaries

Real tests cover competing initial seeds, binary reload, duplicate/conflicting requests, delayed autosaves after deletion, forced CAS overlap, receipt/state invisibility before COMMIT, insert/deferred-COMMIT rollback, backend termination before commit and retry, generation rejection, receipt pruning, bigint precision, corruption checks, queue recovery and database privileges.

This storage suite by itself supplies no Hocuspocus socket, browser editor, production migration or learner authentication flow. Rebuilding a store object is not a process-restart test. Separate M0.4c tests now add provider and real process/database recovery evidence; revocation, full browser-to-server IDE and production integration remain M1/M3. The fixtures leave no running database/application service.

## Subsequent M0 transport evidence

The separate `test:transport` suite now exercises real Hocuspocus/provider sync, correlated server-only receipts, rejection paths and collaboration process SIGKILL/restart. Python also exercises a committed binary checkpoint/receipt through immediate PostgreSQL shutdown and WAL recovery using fresh Node processes. See [the consolidated M0 record](m0-validation.md) for current commands and measured scope. These additions do not turn fixture DDL/admission into production schema/auth or establish product capacity/backup guarantees.

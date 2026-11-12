# M0 integration proof record

Environment: 13 November 2026, macOS arm64. All source is independently authored. PyTogether and local design references were not modified. These are owned disposable fixtures, not production services or a completed product interface.

## Scope and results

| Gate                 | Evidence                                                                                                                                                                                                                                                                                                                                                          | Boundary                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Checkpoint wire      | Strict v1 request/receipt/error parsing and correlation; remote/deletion-only counters                                                                                                                                                                                                                                                                            | Parsing does not authorize callers or prove commit                                                             |
| PostgreSQL storage   | 20 native cases: canonical seed races, forced CAS overlap, delete preservation, delayed stale autosave, duplicate/conflicting retries, atomic visibility, insert/COMMIT failure rollback, killed backend, checksum/generation, bigint and grants                                                                                                                  | Test-only `checkpoint_proof` schema; Django production mapping is M1/M3                                        |
| Hocuspocus transport | 13 native cases: real providers, concurrent sync/deletes, offline reconnect, exact retry, dirty observation, point-to-point receipts, forged reply/internal broadcast rejection, session mismatch, read-only admission, invalid CRDT rejection, DB failure and blocked subsequent writes, transient awareness, process SIGKILL/restart                            | Fixture grants, not learner auth or authorization leases; one local collaboration owner                        |
| Database recovery    | Real checkpoint/receipt before immediate PostgreSQL shutdown; WAL recovery into the same owned data directory; a fresh Node process loads exact binary source and replays the same receipt                                                                                                                                                                        | No filesystem/power-loss, backup/restore or HA guarantee                                                       |
| Runner contract      | Synchronous immutable capture, exact UTF-8, per-file/canonical manifest hashing, path/size/duplicate checks, version/nonce/ID/field validation                                                                                                                                                                                                                    | Python source files only in proof; extra data/package/export formats require an explicit contract              |
| Browser execution    | Cross-site HTTPS iframe and private channel; Worker headers, core Pyodide/Python 3.14, CodeMirror binding, multi-file frozen source, chunked Unicode stdout/stderr, fresh globals/files, batch EOF, interactive stdin, Stop/replacement, 30s deadline, 1MiB output cap, denied app/external requests, tampering/reused IDs/handshake rejection, declared fallback | Owned engine fixtures; no production auth/cookie integration, product rendering, memory quota or grading claim |
| Design               | Original DESIGN.md and light/dark semantic tokens; named text/control contrast checks                                                                                                                                                                                                                                                                             | Components, rendered/responsive/assistive-technology QA remain M1/M5                                           |

The regular suite has **153 tests**. Native suites have **20 storage + 13 transport** cases. Python has **29 tests** (19 prerequisite/unit + 10 native, including binary recovery). The browser suite contains **13 cases per selected engine**, with no retry or silent skip. Full commands below make each gate explicit; the normal Vitest run excludes native integration files and does not collect Playwright specs.

## Browser matrix

| Engine                                           | Version / build                | Embedded SAB + interactive | Batch fallback                                | M0 status                                                           |
| ------------------------------------------------ | ------------------------------ | -------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Chromium                                         | 158.0.8127.18; Playwright 1254 | Confirmed in actual iframe | Confirmed with isolation intentionally absent | Measured proof target                                               |
| WebKit                                           | 27.2; Playwright 2388          | Confirmed in actual iframe | Confirmed with isolation intentionally absent | Measured proof target                                               |
| Firefox                                          | 159.0; Playwright 1572         | Unverified                 | Unverified                                    | Launcher blocked before navigation: `Could not find profile folder` |
| Retail Safari/Chrome/Edge, Linux/Windows, mobile | Not exercised                  | Unverified                 | Unverified                                    | Product certification deferred                                      |

Firefox installation completed, but fresh launches failed in the default OS temp directory, `/private/tmp` and an owned project-local profile. No existing user browser/profile or system trust setting was changed. Its suite remains available as `test:firefox` and fails visibly until the launcher works. Default `test:browser` selects the two measured engines explicitly; `test:all` still includes Firefox. Do not call this all-browser support or hide failed engines behind test skips. M0 proves the approved architecture on the declared two-engine baseline; Firefox eligibility remains an explicit follow-up gate before claiming support.

The first browser run found two defects that were fixed and rechecked: the fixture must serve WebAssembly as exactly `application/wasm`; Chromium's TextDecoder needs a non-shared copy of the input mailbox. The first transport attempt found explicit shared-socket provider attachment and a string-only parser boundary mismatch; regression tests cover the corrected path. No failed run is counted as passing evidence.

## Commands from the repository root

Follow README prerequisites/cache setup, then:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm test
corepack pnpm audit
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .

# Supply your trusted PostgreSQL 18 binaries first.
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
uv run --locked --offline python -m pytest -q
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:integration
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:transport

# Explicit one-time browser download, independent of npm lifecycle scripts.
corepack pnpm --filter @code-along/browser-proofs exec playwright install chromium webkit
corepack pnpm --filter @code-along/runner-web build
corepack pnpm --filter @code-along/browser-proofs build
corepack pnpm --filter @code-along/browser-proofs test:browser

# Additional engine gate; not part of the measured baseline on this machine.
corepack pnpm --filter @code-along/browser-proofs exec playwright install firefox
corepack pnpm --filter @code-along/browser-proofs test:firefox
```

Browser tests require free local port 9443, OpenSSL and permission to launch owned browsers/listen on loopback. They generate temporary TLS material, verify the runtime asset inventory before serving, use no reference/shared DB and close their own server. Build outputs, temporary keys, dependency caches and test traces stay outside Git. A certificate error exception belongs only to this owned fixture; never copy it into production clients.

## Remaining product gates

No Django/React product, real account/project API, production migrations, collaboration admission/leases/revocation, user-facing save state, durable history/chat, submission or deployment is supplied here. Full browser-to-server IDE, named revisions, multi-file transaction boundaries, process quotas, API protection, production asset packaging, CSP on deployed TLS domains, backup restoration and load goals remain assigned milestones. A local engine proof does not establish 2–6 editors/room, 30 learners/workspace, resource isolation against browser exploits or zero loss of unacknowledged edits.

See [decisions](decisions.md), [runner threat model](runner-threat-model.md), [storage proof](checkpoint-persistence-proof.md), [checkpoint wire protocol](../protocols/collaboration-checkpoints.md) and [DESIGN.md](../../DESIGN.md). M1 begins only after this bundle's review/commit/progress step; push/deployment requires separate authorization.

## Final review checks

The frozen offline install was repeated in an owned clean six-workspace directory. Lint/format/all source/test typechecks, 153 regular tests, both fixture builds, 20 storage and 13 transport cases, native Node source imports and lock preservation passed there. The normal development tree also passed all 29 Python and 26 declared-browser cases. A deliberately mismatched runtime inventory was rejected before listening and its temporary TLS material was removed. The dependency audit reported no known vulnerabilities at review time. Original source/design references were hash-checked unchanged; no deployment or push was performed.

## Completion bundle file inventory

Proposed commit: `completed M0 foundation`. These are the new/updated files relative to the approved M0.4b commit. Dependency caches, browser binaries, TLS keys, traces, build output and reference material are excluded.

- [AGENTS.md](../../AGENTS.md)
- [DESIGN.md](../../DESIGN.md)
- [IMPLEMENTATION_PROGRESS.md](../../IMPLEMENTATION_PROGRESS.md)
- [README.md](../../README.md)
- [apps/collaboration/package.json](../../apps/collaboration/package.json)
- [apps/collaboration/src/protocol/checkpoint-client.ts](../../apps/collaboration/src/protocol/checkpoint-client.ts)
- [apps/collaboration/src/protocol/proof-server.ts](../../apps/collaboration/src/protocol/proof-server.ts)
- [apps/collaboration/tests/fixtures/restart-probe.ts](../../apps/collaboration/tests/fixtures/restart-probe.ts)
- [apps/collaboration/tests/fixtures/transport-process.ts](../../apps/collaboration/tests/fixtures/transport-process.ts)
- [apps/collaboration/tests/protocol/checkpoint-client.test.ts](../../apps/collaboration/tests/protocol/checkpoint-client.test.ts)
- [apps/collaboration/tests/protocol/transport.integration.test.ts](../../apps/collaboration/tests/protocol/transport.integration.test.ts)
- [apps/collaboration/tsconfig.json](../../apps/collaboration/tsconfig.json)
- [apps/collaboration/vitest.transport.config.ts](../../apps/collaboration/vitest.transport.config.ts)
- [apps/runner-web/index.html](../../apps/runner-web/index.html)
- [apps/runner-web/package.json](../../apps/runner-web/package.json)
- [apps/runner-web/public/runtime-manifests/pyodide-core.json](../../apps/runner-web/public/runtime-manifests/pyodide-core.json)
- [apps/runner-web/src/bootstrap.ts](../../apps/runner-web/src/bootstrap.ts)
- [apps/runner-web/src/supervisor.ts](../../apps/runner-web/src/supervisor.ts)
- [apps/runner-web/src/worker.ts](../../apps/runner-web/src/worker.ts)
- [apps/runner-web/tsconfig.json](../../apps/runner-web/tsconfig.json)
- [apps/runner-web/tsconfig.worker.json](../../apps/runner-web/tsconfig.worker.json)
- [apps/runner-web/vite.config.ts](../../apps/runner-web/vite.config.ts)
- [docs/architecture/checkpoint-persistence-proof.md](checkpoint-persistence-proof.md)
- [docs/architecture/decisions.md](decisions.md)
- [docs/architecture/m0-validation.md](m0-validation.md)
- [docs/architecture/runner-threat-model.md](runner-threat-model.md)
- [docs/operations/postgres-tests.md](../operations/postgres-tests.md)
- [packages/contracts/execution/runner.ts](../../packages/contracts/execution/runner.ts)
- [packages/contracts/package.json](../../packages/contracts/package.json)
- [packages/contracts/tests/runner.test.ts](../../packages/contracts/tests/runner.test.ts)
- [packages/contracts/tsconfig.json](../../packages/contracts/tsconfig.json)
- [packages/contracts/tsconfig.test.json](../../packages/contracts/tsconfig.test.json)
- [packages/design-system/package.json](../../packages/design-system/package.json)
- [packages/design-system/src/tokens.css](../../packages/design-system/src/tokens.css)
- [pnpm-lock.yaml](../../pnpm-lock.yaml)
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml)
- [tests/browser/index.html](../../tests/browser/index.html)
- [tests/browser/package.json](../../tests/browser/package.json)
- [tests/browser/playwright.config.ts](../../tests/browser/playwright.config.ts)
- [tests/browser/server.ts](../../tests/browser/server.ts)
- [tests/browser/specs/runner.spec.ts](../../tests/browser/specs/runner.spec.ts)
- [tests/browser/src/app.ts](../../tests/browser/src/app.ts)
- [tests/browser/tsconfig.json](../../tests/browser/tsconfig.json)
- [tests/browser/vite.config.ts](../../tests/browser/vite.config.ts)
- [tests/design/tokens.test.ts](../../tests/design/tokens.test.ts)
- [tests/python/test_checkpoint_recovery.py](../../tests/python/test_checkpoint_recovery.py)
- [tsconfig.json](../../tsconfig.json)

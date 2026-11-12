# Code Along

Code Along is an independently implemented collaborative Python learning and development platform. The approved design combines shared multi-file editing with local Python practice, assignments, immutable submissions and instructor feedback, using original UI/UX and branding.

## Current state

Architecture approved on 13 November 2026. M0.1 recorded the design and development plan; M0.2 tooling is complete. M0.3 added the shared collaboration checkpoint contract and protocol tests. M0.4a added disposable PostgreSQL 18 clusters; M0.4b implements and tests the binary checkpoint store. There is no application UI, migration or persistent service yet.

- [Approved architecture](docs/architecture/approved-architecture.html): feature comparison, technology decisions, domain/schema relationships, protocols, security boundaries, target folder structure and milestone gates. Open the HTML file in a browser. Some historical investigation links refer to machine-local files and are not portable.
- [Implementation tracker](IMPLEMENTATION_PROGRESS.md): task order, dependencies, acceptance criteria, status, review state and commit records.
- [Repository instructions](AGENTS.md): engineering, security, verification and commit-approval rules.

## Approved architecture

| Responsibility                        | Technology / boundary                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Product UI                            | React, TypeScript, Vite, React Router, TanStack Query                                                       |
| Editor and shared text                | CodeMirror 6, Yjs; narrow Node 24 LTS/Hocuspocus service                                                    |
| Product policy and APIs               | Python 3.13, Django 5.2 LTS, DRF, Channels                                                                  |
| Durable storage                       | PostgreSQL 18, including binary CRDT checkpoints                                                            |
| Transient coordination / trusted jobs | Redis, Celery; never execute learner code in application workers                                            |
| Browser practice                      | Pinned Pyodide in a supervised Worker on a separate runner site                                             |
| Design system                         | Original semantic tokens and accessible primitives, guided by Taste Skill, web-design and Awesome DESIGN.md |
| Later authoritative grading           | Separate Linux execution hosts, sandbox controller and external trusted scoring                             |

Exact compatible patches, dependency locks and image digests will be verified in M0. A peer-sync event is not a durable save acknowledgment. Local practice results are not trusted grades. Submissions preserve the exact accepted source/runtime manifest. Workspace teaching roles do not grant blanket access to private live projects.

## Release scope

M0 validates the critical integrations. M1–M5 deliver the first release: accounts/workspaces/project permissions, multi-file IDE, isolated local execution, collaboration/cursors, durable saves and chat, named revisions/sharing, assignments/hints/visible checks, immutable submissions and instructor feedback.

M6 adds optional trusted server grading behind a security gate. M7 adds prioritized voice, durable drawing and further collaborative learning capabilities. Full task details are in the tracker.

## Setup and verification

Activate Node **24.22.3** (recorded in `.node-version`) and Corepack; Corepack **0.36.0** was verified locally. `package.json` pins pnpm **12.18.0**. No global pnpm installation or `corepack enable` is needed: [Corepack supports direct package-manager invocation](https://github.com/nodejs/corepack).

Run these POSIX-shell commands from the Code Along repository root:

```sh
# Keep Corepack downloads in this repository's ignored local cache.
export COREPACK_HOME="$PWD/.pnpm-store/corepack"
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

The first install needs access to the npm registry. Dependency lifecycle scripts are disabled in workspace configuration; the current tooling works without them. An out-of-date dependency installation causes script commands to fail rather than silently reinstall. Run the frozen install again when an approved dependency change requires it. Review any future dependency that needs lifecycle scripts before changing this setting. See [pnpm build settings](https://pnpm.io/settings/build).

| Command                      | Current behavior                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm lint`         | Lints JavaScript/TypeScript with ESLint; warnings fail the check                                                |
| `corepack pnpm format:check` | Checks formatting; excludes the archived architecture and generated lockfile                                    |
| `corepack pnpm format`       | Formats supported repository files; review the diff before staging                                              |
| `corepack pnpm typecheck`    | Checks root tooling plus each workspace package; contracts source is checked separately from its Node/Yjs tests |
| `corepack pnpm check`        | Runs lint, format check and typecheck; run `test` separately for behavioral checks                              |
| `corepack pnpm test`         | Runs the protocol test suite, including actual Yjs deletion/remote-update cases; empty suites still fail        |

The regular JavaScript suite has **133 tests**: 122 protocol cases in `packages/contracts/tests/checkpoints.test.ts` and 11 binary-state validation cases. A separate native-database suite has **20 integration tests**. These passed in the development tree and a clean cached workspace. No pass-with-no-tests bypass is enabled. The regular suite verifies contract/binary validation; the separate integration suite verifies real transactions and receipts in a disposable PostgreSQL fixture. Neither is a live browser/provider proof. M0.2's temporary tool fixtures were removed after verification.

### Pinned JavaScript tools

| Tool                | Version          |
| ------------------- | ---------------- |
| pnpm                | 12.18.0          |
| TypeScript          | 6.0.3            |
| ESLint / @eslint/js | 10.14.0 / 10.0.1 |
| typescript-eslint   | 8.72.2           |
| Prettier            | 3.10.0           |
| Vitest / Vite       | 5.1.0 / 8.3.8    |
| @types/node         | 24.19.2          |

TypeScript 6.0.3 satisfies the selected parser's declared `<6.1.0` peer range; TypeScript 7 does not. [Parser release metadata](https://registry.npmjs.org/typescript-eslint/8.72.2). Vite is an explicit Vitest peer dependency, not an implemented frontend. Prettier 3.10.0 avoids the newer patch's release-age exception. Exact direct versions and the pnpm-generated lockfile preserve the tested dependency graph; pnpm's strict engine/peer checks remain enabled. The workspace uses [current pnpm settings](https://pnpm.io/settings) and [ESLint flat configuration](https://typescript-eslint.io/getting-started/).

The initial audit identified [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in minimatch 10.2.6. Workspace overrides resolve only the affected ESLint, @eslint/config-array and @typescript-eslint/typescript-estree dependency edges to patched **11.0.1**. This is a deliberate cross-major substitution: frozen-install and lint positive/negative checks were rerun, and the resulting audit reported no known vulnerabilities. Remove these temporary overrides when the parent packages adopt patched versions, rerunning the checks rather than widening unrelated dependencies. Audit results describe the check date, not a guarantee against undiscovered issues.

Root tooling and the first private workspace, `@code-along/contracts`, now exist. The workspace still reserves apps/* without creating empty applications. Yjs 13.6.33 is test-only in contracts; the exported runtime contract has no third-party dependencies. The collaboration storage package uses Yjs 13.6.33 and pg 8.23.1 with @types/pg 8.23.1. No React or Hocuspocus server is installed yet. Python tooling is documented below. macOS arm64 was verified; browsers and other operating systems have not been tested.

### Collaboration checkpoint contract

Read the [v1 protocol specification](docs/protocols/collaboration-checkpoints.md) and [shared implementation](packages/contracts/collaboration/checkpoints.ts).

- `parseCheckpointRequest` and `parseCheckpointResponse` validate bounded JSON envelopes, exact versions/fields, canonical base64, UUIDs, safe counters, digests and decimal PostgreSQL revisions. Parsing does not authorize access or prove valid Yjs state.
- `receiptCoversObservedState` matches a trusted parsed receipt to the immutable pending request and current observed document/session/generation/counter. Older receipts, errors, remote edits and deletion-only changes cannot incorrectly mark the current observation Saved.
- The package exports source TypeScript via `@code-along/contracts/collaboration`. Source is typechecked without Node globals; tests have their own Node/DOM declarations because Yjs's XML types refer to DOM interfaces. Native Node 24 import and the Vitest package export were verified. This does not claim a browser runtime test.

Run `corepack pnpm test` locally to exercise the first protocol behavior. The storage proof below now verifies real save transactions/idempotency; auth integration, Hocuspocus transport and restart behavior remain M0.4c/M3 work. There is no localhost application preview or start command yet. Provider sync is never a commit receipt; a checksum is not an authentication mechanism or named source revision.

### Binary checkpoint storage proof

The [persistence proof guide](docs/architecture/checkpoint-persistence-proof.md) explains the new `apps/collaboration/src/persistence/` component. It initializes canonical binary state once, merges autosaves/checkpoints through the same queue, uses revision compare-and-swap to preserve competing edits, and returns receipts after an atomic PostgreSQL commit. Retries return the original receipt; conflicting checkpoint-key reuse is rejected.

Run the real database suite through the private harness:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:integration
```

Set CODE_ALONG_POSTGRES_BIN as described below first. `corepack pnpm test` runs the regular suite only; it explicitly excludes `*.integration.test.ts`. The separate native command runs all 20 integration tests and fails without the required harness. Django still owns production schema/migrations; the SQL fixture is not a product migration. This is a storage component with no public server, authorization integration or preview URL.

### Python tooling

Use Python **3.13.12** (recorded in `.python-version`) and uv **0.10.9**. The root project requires Python `>=3.13,<3.14`, and `tool.uv.required-version` pins the tested uv release. It is a non-packaged development project: no Django application or distribution is created or installed yet. Runtime/framework dependencies will be added by their owning task.

From the repository root, with those prerequisites already installed:

```sh
# Keep uv's package cache local and ignored; .venv is ignored as well.
export UV_CACHE_DIR="$PWD/.uv-cache"
uv sync --locked --no-python-downloads
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .
```

The initial sync needs PyPI access; subsequent commands above use the installed/cached tools. `--no-python-downloads` requires the pinned interpreter to be available, rather than silently downloading another Python. Use `--locked` to reject stale dependency metadata: uv's `--frozen` instead trusts the existing lock without checking it against the manifest. [uv locking/syncing documentation](https://docs.astral.sh/uv/concepts/projects/sync/).

| Tool   | Version / responsibility                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Python | 3.13.12; isolated project interpreter                                        |
| uv     | 0.10.9; `uv.lock`, environment and dependency management                     |
| Ruff   | 0.17.5; Python linting, import ordering, modernization checks and formatting |
| pytest | 9.2.0; strict configuration/markers and importlib-based test imports         |

Direct development versions are exact; the lock also records transitive versions and artifact hashes. `tool.uv.no-build` requires prebuilt wheels and prevents source-distribution builds during these installs. The installed environment uses six third-party packages on macOS; the lock also records Windows-only colorama. No global Python packages or system interpreter changes were made.

Python tests now cover the real PostgreSQL 18 harness as well as prerequisite failures. Run `uv run --locked --offline python -m pytest -q` with CODE_ALONG_POSTGRES_BIN configured as described below. Empty-suite exits are never treated as passing coverage. Temporary M0.2 tool fixtures were removed; the clean cached install and lock/interpreter/version rejection checks remain verified.

Ruff ignores local dependencies/caches and `.design-references/`, including explicit paths via force-exclude. Pytest avoids hidden directories, node_modules and build directories. These settings protect reference material from accidental lint fixes and prevent collecting third-party tests. See [Ruff configuration](https://docs.astral.sh/ruff/configuration/) and [pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html).

No Python type checker or Django-specific pytest plugin is installed yet; select and verify those when real backend source/framework dependencies are introduced. Tooling is verified on macOS arm64 only. PyPI's version metadata reported no published advisories for the seven locked third-party versions when checked on 13 November 2026; this is a point-in-time metadata check, not a claim that all vulnerabilities are known or that `uv sync` performs a CVE audit.

### PostgreSQL 18 test clusters

Read [PostgreSQL test setup and lifecycle](docs/operations/postgres-tests.md). Supply a trusted PostgreSQL 18 bin directory; the full Python suite starts only disposable private Unix-socket clusters, with TCP disabled and durability settings on:

```sh
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
uv run --locked --offline python -m pytest -q
```

The path is a placeholder for your installation. PostgreSQL 18.7 was compiled and verified outside the repository on this machine; no global service or reference database was changed. The harness validates tool versions, strips inherited PG connection settings, propagates child failures and cleans up after normal/error/handled-interrupt paths. Unit-only prerequisite checks can run with `-m 'not postgres'`, explicitly excluding integration coverage.

The first Python suite has **28 tests** (19 prerequisite/unit cases and 9 real-cluster integration cases). The tests verify version/settings, transaction rollback, isolation and process cleanup. The separate M0.4b suite now proves storage/receipt transactions; M0.4c still needs actual Hocuspocus transport and process-restart evidence. The tests leave no running application/database service or preview URL.

No credentials belong in documentation or source control. PyTogether remains a read-only technical reference; its code, assets and branding are not imported into the application.

## Repository hygiene

`.gitignore` excludes local environment/credential files, dependency directories, virtual environments, caches, test reports, build outputs and local databases. Root `.env.example`, nested `.env.example`, `.env.test.example`, Python/JavaScript source and dependency lockfiles remain eligible for Git. Examples must contain placeholders only. Git ignore rules do not remove already tracked secrets; review the staged diff before each commit.

`.design-references/` remains an ignored local design library, preserved on disk and excluded from Git. It must not be included in future production images or asset bundles. The existing clone has not been imported or modified.

Use `git status --short`, `git diff --cached --check` and `git diff --cached` to inspect a proposed unit. A file being eligible for Git is not approval to include it.

## Development workflow

During foundation work, group 2–3 closely related tasks into one reviewable unit when they share a coherent purpose. Implement and verify each task sequentially before starting the next task in that bundle. Review the combined diff and request one commit approval. Keep substantial protocol, persistence, authentication and execution-security changes separate. Milestone order remains unchanged; the task count is a guideline.

For each independently reviewable unit:

1. Plan its scope, dependencies, files and verification criteria.
2. Implement that unit and update its documentation/tracker.
3. Run relevant checks and review the complete diff, including intended staged files and secret/generated-file exclusions.
4. Show the proposed conventional commit message and changed files; wait for explicit approval.
5. Commit only the approved unit, record its hash in the tracker, then proceed to the next task.

Do not push, merge or deploy without separate explicit approval. Stop for approval before changing an accepted architectural decision.

The tracker distinguishes verified work from committed work. A commit cannot contain its own final hash: after an approved commit, record its hash in the next tracker update, to be included in the next approved unit. Never create an unapproved bookkeeping commit or amend a reviewed commit solely to insert that hash.

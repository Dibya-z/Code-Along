# Code Along

Code Along is an independently implemented collaborative Python learning and development platform. The approved design combines shared multi-file editing with local Python practice, assignments, immutable submissions and instructor feedback, using original UI/UX and branding.

## Current state

Architecture approved on 13 November 2026. M0 integration proofs and design tokens are committed/pushed. M1.1 adds the Django backend foundation. M1.2 adds a verified local Compose stack, HTTPS proxy, DB/Redis readiness, isolated runner assets and a disposable native fallback. M1.3 adds a responsive React shell, typed CSRF-aware client, reusable accessible primitives and Storybook. Account and workspace/project behavior follow in the next M1 units. Nothing is deployed. See [local development setup](docs/operations/development-stack.md).

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

Critical proof dependencies are pinned and measured in M0; product framework pins and deployment image digests are verified when introduced in M1. A peer-sync event is not a durable save acknowledgment. Local practice results are not trusted grades. Submissions preserve the exact accepted source/runtime manifest. Workspace teaching roles do not grant blanket access to private live projects.

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

The regular JavaScript suite has **153 tests**: 122 checkpoint protocol, 11 binary validation, 2 checkpoint controller, 16 execution contract and 2 theme contrast cases. Separate native suites have **20 storage** and **13 transport** cases. Browser and Python gates are listed below. No empty-suite bypass is enabled; each gate reports its actual scope rather than claiming whole-product coverage.

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

TypeScript 6.0.3 satisfies the selected parser's declared `<6.1.0` peer range; TypeScript 7 does not. [Parser release metadata](https://registry.npmjs.org/typescript-eslint/8.72.2). Vite is a Vitest peer and now builds the two browser/runner fixtures; a React product frontend is not implemented. Prettier 3.10.0 avoids the newer patch's release-age exception. Exact direct versions and the pnpm-generated lockfile preserve the tested dependency graph; pnpm's strict engine/peer checks remain enabled. The workspace uses [current pnpm settings](https://pnpm.io/settings) and [ESLint flat configuration](https://typescript-eslint.io/getting-started/).

The initial audit identified [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in minimatch 10.2.6. Workspace overrides resolve only the affected ESLint, @eslint/config-array and @typescript-eslint/typescript-estree dependency edges to patched **11.0.1**. This is a deliberate cross-major substitution: frozen-install and lint positive/negative checks were rerun, and the resulting audit reported no known vulnerabilities. Remove these temporary overrides when the parent packages adopt patched versions, rerunning the checks rather than widening unrelated dependencies. Audit results describe the check date, not a guarantee against undiscovered issues.

The six JavaScript workspaces are the root, contracts, collaboration, runner-web, browser-proofs and design-system; the Python workspace now adds apps/api. Only modules required by these proofs exist. Yjs 13.6.33 is test-only in contracts; the exported runtime contract has no third-party dependencies. The collaboration storage package uses Yjs 13.6.33 and pg 8.23.1 with @types/pg 8.23.1. Hocuspocus server/provider 4.8.0, Pyodide 314.0.7 and CodeMirror binding dependencies are now pinned for the proofs. No React product exists yet. The exact stack and measured browser scope are in the [M0 report](docs/architecture/m0-validation.md).

### Collaboration checkpoint contract

Read the [v1 protocol specification](docs/protocols/collaboration-checkpoints.md) and [shared implementation](packages/contracts/collaboration/checkpoints.ts).

- `parseCheckpointRequest` and `parseCheckpointResponse` validate bounded JSON envelopes, exact versions/fields, canonical base64, UUIDs, safe counters, digests and decimal PostgreSQL revisions. Parsing does not authorize access or prove valid Yjs state.
- `receiptCoversObservedState` matches a trusted parsed receipt to the immutable pending request and current observed document/session/generation/counter. Older receipts, errors, remote edits and deletion-only changes cannot incorrectly mark the current observation Saved.
- The package exports source TypeScript via `@code-along/contracts/collaboration`. Source is typechecked without Node globals; tests have their own Node/DOM declarations because Yjs's XML types refer to DOM interfaces. Native Node 24 import and the Vitest package export were verified. The separate browser proof exercises the execution package and CodeMirror/Yjs binding; it is not a complete browser-to-server IDE.

Run `corepack pnpm test` locally to exercise the first protocol behavior. The storage proof below now verifies real save transactions/idempotency; real Hocuspocus transport and restart tests are also supplied below; production auth remains M1/M3 work. The product frontend has no preview yet; backend startup and browser proof commands are listed below. Provider sync is never a commit receipt; a checksum is not an authentication mechanism or named source revision.

### Binary checkpoint storage proof

The [persistence proof guide](docs/architecture/checkpoint-persistence-proof.md) explains the new `apps/collaboration/src/persistence/` component. It initializes canonical binary state once, merges autosaves/checkpoints through the same queue, uses revision compare-and-swap to preserve competing edits, and returns receipts after an atomic PostgreSQL commit. Retries return the original receipt; conflicting checkpoint-key reuse is rejected.

Run the real database suite through the private harness:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:integration
```

Set CODE_ALONG_POSTGRES_BIN as described below first. `corepack pnpm test` runs the regular suite only; it explicitly excludes `*.integration.test.ts`. The separate native command runs all 20 integration tests and fails without the required harness. Django still owns production schema/migrations; the SQL fixture is not a product migration. The separate loopback transport fixture adds no public server or production authorization integration.

### Remaining M0 proofs

Read the [M0 validation report](docs/architecture/m0-validation.md), [runner threat model](docs/architecture/runner-threat-model.md), [architecture decisions](docs/architecture/decisions.md) and [original design direction](DESIGN.md).

With the same PostgreSQL prerequisite, run real providers against a disposable database:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:transport
```

For local cross-site execution tests, install the owned browser engines explicitly and build both fixture applications:

```sh
corepack pnpm --filter @code-along/browser-proofs exec playwright install chromium webkit
corepack pnpm --filter @code-along/runner-web build
corepack pnpm --filter @code-along/browser-proofs build
corepack pnpm --filter @code-along/browser-proofs test:browser
```

This requires OpenSSL and free loopback port 9443. The test fixture serves the app at HTTPS 127.0.0.1 and runner at HTTPS localhost with separate-site policy, a temporary self-signed certificate and fixed hash-verified runtime assets. It shuts down after the tests. No trust-store or hosts-file changes are needed. The shell build alone is **not deployable**: production runtime asset packaging and configured domains/headers arrive in M1/M2. Temporary keys/traces/builds remain ignored.

The browser gate contains 13 cases each for Chromium and WebKit. Firefox is **unverified** here: its owned launcher reports `Could not find profile folder` before navigation, including with alternate fresh profiles. `test:firefox` remains an explicit failing gate until that environment issue is resolved; `test:all` includes all three engines. Retail-browser/mobile certification remains later work. The report records exact versions and limits; no browser memory quota or trusted grading is claimed.

The design system currently exports only original semantic CSS tokens. Primitives, Storybook and product screens begin in M1.3; technical proof pages are not UI designs to evaluate.

### Python tooling

Use Python **3.13.12** (recorded in `.python-version`) and uv **0.10.9**. The root project requires Python `>=3.13,<3.14`, and `tool.uv.required-version` pins the tested uv release. The root and apps/api form a non-packaged uv workspace: dependencies are installed, while Django runs from its application source directory. The API dependencies are pinned in apps/api/pyproject.toml and share the root uv.lock.

From the repository root, with those prerequisites already installed:

```sh
# Keep uv's package cache local and ignored; .venv is ignored as well.
export UV_CACHE_DIR="$PWD/.uv-cache"
uv sync --locked --no-python-downloads
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .
uv run --locked --offline mypy
```

The initial sync needs PyPI access; subsequent commands above use the installed/cached tools. `--no-python-downloads` requires the pinned interpreter to be available, rather than silently downloading another Python. Use `--locked` to reject stale dependency metadata: uv's `--frozen` instead trusts the existing lock without checking it against the manifest. [uv locking/syncing documentation](https://docs.astral.sh/uv/concepts/projects/sync/).

| Tool   | Version / responsibility                                                     |
| ------ | ---------------------------------------------------------------------------- |
| Python | 3.13.12; isolated project interpreter                                        |
| uv     | 0.10.9; `uv.lock`, environment and dependency management                     |
| Ruff   | 0.17.5; Python linting, import ordering, modernization checks and formatting |
| pytest | 9.2.0; strict configuration/markers and importlib-based test imports         |

Direct development versions are exact; the lock also records transitive versions and artifact hashes. `tool.uv.no-build` requires prebuilt wheels and prevents source-distribution builds during these installs. The expanded backend lock contains 45 third-party entries across supported platforms. No global Python packages or system interpreter changes were made.

Python tests now cover the backend, real PostgreSQL 18 harness and prerequisite failures. Run `uv run --locked --offline python -m pytest -q` with CODE_ALONG_POSTGRES_BIN configured as described below. Empty-suite exits are never treated as passing coverage. Temporary M0.2 tool fixtures were removed; the clean cached install and lock/interpreter/version rejection checks remain verified.

Ruff ignores local dependencies/caches and `.design-references/`, including explicit paths via force-exclude. Pytest avoids hidden directories, node_modules and build directories. These settings protect reference material from accidental lint fixes and prevent collecting third-party tests. See [Ruff configuration](https://docs.astral.sh/ruff/configuration/) and [pytest exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html).

pytest-django 4.14.0 and mypy 1.19.1 with Django stubs/ext 5.2.9 now verify the real backend; run `uv run --locked --offline mypy`. Tooling is verified on macOS arm64 only. PyPI's version metadata reported no published advisories for all 45 locked third-party entries when checked on 13 November 2026; this is a point-in-time metadata check, not a claim that all vulnerabilities are known or that `uv sync` performs a CVE audit.

### Django backend

Read [backend setup, configuration and verification](docs/operations/backend-development.md). M1.1 introduces the first product migration and account model, with Django 5.2.19, DRF 3.18.3, Channels 4.3.2, Daphne 4.2.3 and psycopg 3.3.9. Use `apps/api/.env.example` as a placeholder reference; the app does not automatically load dotenv files or provide default credentials.

With your own local PostgreSQL database and development variables configured:

```sh
export DJANGO_SETTINGS_MODULE=config.settings.development
uv run --locked --offline python apps/api/manage.py check
uv run --locked --offline python apps/api/manage.py migrate
uv run --locked --offline --directory apps/api daphne -b 127.0.0.1 -p 8000 config.asgi:application
```

GET `http://127.0.0.1:8000/health/live/` returns process liveness only. It is not database readiness or a user-facing UI. The full test suite provisions its own private databases and ephemeral server; no persistent service, account, database or migration outside those owned fixtures was created during implementation. Login/registration and real email delivery remain M1.4; Compose/proxy and production header/HSTS configuration remain M1.2. No deployment is authorized by these commands.

### PostgreSQL 18 test clusters

Read [PostgreSQL test setup and lifecycle](docs/operations/postgres-tests.md). Supply a trusted PostgreSQL 18 bin directory; the full Python suite starts only disposable private Unix-socket clusters, with TCP disabled and durability settings on:

```sh
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
uv run --locked --offline python -m pytest -q
```

The path is a placeholder for your installation. PostgreSQL 18.7 was compiled and verified outside the repository on this machine; no global service or reference database was changed. The harness validates tool versions, strips inherited PG connection settings, propagates child failures and cleans up after normal/error/handled-interrupt paths. Unit-only prerequisite checks can run with `-m 'not postgres'`, explicitly excluding integration coverage.

The Python suite now has **97 tests**, including the original 29 plus 68 backend cases. The binary-recovery case additionally requires Node and the installed pnpm workspace. The tests verify version/settings, transaction rollback, isolation and process cleanup. The separate M0.4b suite now proves storage/receipt transactions; M0.4c adds real Hocuspocus transport and process-restart evidence. The tests leave no running application/database service or preview URL.

No credentials belong in documentation or source control. PyTogether remains a read-only technical reference; its code, assets and branding are not imported into the application.

## Repository hygiene

`.gitignore` excludes local environment/credential files, dependency directories, virtual environments, caches, test reports, build outputs and local databases. Root `.env.example`, nested `.env.example`, `.env.test.example`, Python/JavaScript source and dependency lockfiles remain eligible for Git. Examples must contain placeholders only. Git ignore rules do not remove already tracked secrets; review the staged diff before each commit.

`.design-references/` remains an ignored local design library, preserved on disk and excluded from Git. It must not be included in future production images or asset bundles. The existing clone has not been imported or modified.

Use `git status --short`, `git diff --cached --check` and `git diff --cached` to inspect a proposed unit. A file being eligible for Git is not approval to include it.

## Development workflow

By default, group 2–3 closely related foundation tasks when they share a coherent purpose. The owner explicitly authorized completing the remaining M0 tasks in one review bundle after the M0.4b commit; this is a scoped exception, not a change to future milestone commit policy. Implement and verify each task sequentially before starting the next task in that bundle. Review the combined diff and request one commit approval. Keep substantial protocol, persistence, authentication and execution-security changes separate. Milestone order remains unchanged; the task count is a guideline.

For each independently reviewable unit:

1. Plan its scope, dependencies, files and verification criteria.
2. Implement that unit and update its documentation/tracker.
3. Run relevant checks and review the complete diff, including intended staged files and secret/generated-file exclusions.
4. Show the proposed conventional commit message and changed files; wait for explicit approval.
5. Commit only the approved unit, record its hash in the tracker, then proceed to the next task.

Do not push, merge or deploy without separate explicit approval. Stop for approval before changing an accepted architectural decision.

The tracker distinguishes verified work from committed work. A commit cannot contain its own final hash: after an approved commit, record its hash in the next tracker update, to be included in the next approved unit. Never create an unapproved bookkeeping commit or amend a reviewed commit solely to insert that hash.

### Accounts

The account forms now support registration, email verification, login/logout and password reset. See [account flows and private development email](docs/operations/authentication.md). Open the local HTTPS app and choose **Create an account**; verification links are in the private development mail store. Product access requires verified email. Nothing sends real email unless production SMTP is explicitly configured.

Workspace creation, lists, membership roles, owner transfer and archive/restore are implemented. See [workspace policy and APIs](docs/operations/workspaces.md). Membership invitations are the next unit.

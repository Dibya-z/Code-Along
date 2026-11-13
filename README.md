# Code Along

Code Along is an independently implemented collaborative Python learning and development platform with its own UI and branding. The approved design combines shared multi-file programming, local Python practice, assignments, immutable submissions and instructor feedback.

## Current state

M0 integration proofs, M1 product foundation and the M2 Python IDE are implemented. You can register, verify an email locally, sign in, create a workspace, invite another account and create private projects with explicit editor/viewer access.

Projects open a multi-file Python editor with stable tabs, syntax highlighting, undo and adjustable text size. Run code executes a complete frozen source snapshot in a fresh, separate-site Python Worker. It offers batch/interactive input, a bounded plain-text console, captured-source inspection, PNG plots and Stop. Core and opt-in NumPy use reviewed, hash-pinned assets; Matplotlib awaits compatible dependencies that pass the advisory gate. See [runtime profiles](packages/runtime-profiles/README.md). Desktop editor/console panes resize with a keyboard-friendly control; small screens retain both panes behind Editor/Console buttons.

Account-scoped [local recovery](docs/protocols/local-recovery.md) preserves edits on this device, with explicit restore, two-tab conflict handling and source exports. It clears on sign-out by default, with optional device retention. Wait for “Local recovery updated” before closing. **Local drafts** offers three original templates, validated `.codealong.json` import, file operations and source exports. **Open local copy** captures project edits into an independent device-only draft.

An already open complete project/local draft can run offline after its trusted runner connection and chosen environment are warmed. Large verified runtime assets stay in the frame's bounded memory cache; small scripts still need the browser cache. Stop, navigation, eviction or invalid/untrusted HTTPS can require a connection again. Cold offline login/installation is not provided, and login/API responses are never persisted. See [execution and offline limits](docs/protocols/product-execution.md). Collaboration, durable server saves and chat follow in M3. Nothing is deployed.

Open **https://127.0.0.1:8443** after starting the [local development stack](docs/operations/development-stack.md). This workstation uses the project-owned Lima VM; that guide includes its exact commands. Development verification/reset emails stay in a private local mail store, described in the [account guide](docs/operations/authentication.md).

- [Implementation tracker](IMPLEMENTATION_PROGRESS.md): milestones, dependencies, verification, commits and remaining work.
- [M2 validation report](docs/architecture/m2-validation.md): editor/runner/recovery functionality, browser evidence and remaining boundaries.
- [M1 validation report](docs/architecture/m1-validation.md): completed functionality, test evidence, CI and limitations.
- [Approved architecture](docs/architecture/approved-architecture.html): decisions, schema, protocols and roadmap. Open the HTML in a browser; some archived investigation links are machine-local.
- [Design direction](DESIGN.md) and [repository instructions](AGENTS.md).

## Architecture and implemented modules

| Responsibility         | Technology / boundary                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Product UI             | React 19, TypeScript 6, Vite, React Router, TanStack Query                                      |
| Product APIs           | Python 3.13, Django 5.2 LTS, DRF, Channels/Daphne                                               |
| Identity               | allauth headless, verified email, host-only Django sessions and CSRF                            |
| Durable storage        | PostgreSQL 18; Django owns product migrations                                                   |
| Transient coordination | Redis; shared account/API abuse controls                                                        |
| Design system          | Original tokens, Radix-based primitives, Tailwind and Storybook                                 |
| API contracts          | Offline-generated OpenAPI and typed clients with CI drift checks                                |
| Local editor, M2       | CodeMirror 6 and stable per-file Yjs documents                                                  |
| Local recovery, M2     | Account-scoped Dexie/IndexedDB binary records with revision/epoch checks                        |
| Collaboration, M3      | Narrow Node/Hocuspocus service; checkpoint/transport proofs await product integration           |
| Browser execution, M2  | Hash-pinned Pyodide; frozen product runs in a separate-site supervised fresh Worker             |
| Later trusted grading  | Separate Linux sandbox hosts and external scoring; never Django or ordinary application workers |

Workspace teaching roles do not grant access to private projects. Provider synchronization is not a durable save receipt. Browser practice is not a trusted grade. Runtime/framework/tool versions are exact in the lockfiles, and development base images use digest pins.

```text
apps/api/                 Django config, accounts, workspaces and projects
apps/web/                 React routes, feature screens and credential transport
apps/collaboration/       Binary checkpoint/transport proofs (M3 integration later)
apps/runner-web/          Separate-site supervised Pyodide product runner and v1 proof adapter
packages/api-client/      Generated product/auth types and client factories
packages/contracts/       Versioned checkpoint and execution contracts
packages/design-system/   Original tokens, reusable controls and stories
packages/runtime-profiles/ Reviewed self-hosted runtime/package inventories
tests/browser/            Owned runner, UI and two-user product browser checks
tools/dev/                Disposable service harnesses, setup and schema generation
tools/ci/                 CI-only native tools, dependency and Compose checks
infra/                    Digest-pinned development containers and HTTPS proxy
docs/                     Architecture, API contracts, protocols and operations
```

The eight JavaScript workspaces include the root; the root/API share one uv workspace. Only modules needed so far have been created. PyTogether and the ignored `.design-references/` library remain read-only references; their code, assets and branding are not imported.

## Install development dependencies

Use Node **24.22.3**, Corepack **0.36.0**, pnpm **12.18.0**, Python **3.13.12** and uv **0.10.9**. Versions are recorded in the tool/version files and manifests. From the repository root:

```sh
export COREPACK_HOME="$PWD/.pnpm-store/corepack"
export UV_CACHE_DIR="$PWD/.uv-cache"
corepack pnpm install --frozen-lockfile
uv sync --locked --no-python-downloads
```

The first install needs the public registries. Dependency lifecycle scripts and Python source builds are disabled; use the pinned interpreter and wheels. An outdated lock/install fails rather than silently changing dependencies. No global pnpm, Python package or database service is installed by these commands. For app startup, use the [Compose/native setup guide](docs/operations/development-stack.md).

## Run the complete application locally

After the prerequisites above, run from the repository root:

```sh
npm run dev
```

Open **https://127.0.0.1:8443** and keep the terminal open. The command builds/starts the backend, database, Redis, HTTPS proxy and React watcher. Frontend source edits update the browser automatically; restart the command after backend/dependency changes to rebuild their images. It uses this workstation's existing owned Lima VM when present, or a working Docker engine on other machines. The first uncached build needs registry access.

```sh
npm run status                 # Read current state; never starts a stopped VM.
npm run mail                   # Check whether local verification mail exists.
npm run mail -- --latest        # Read the latest message privately.
npm run stop                   # Stop services; preserve database and mail.
```

Ctrl+C in the development terminal also stops the services. With the dedicated Lima engine, shutdown also stops that owned VM and releases its allocated memory. Direct Docker engines are shared, so only this Compose project is stopped. Duplicate development controllers are rejected; repeated stops are safe. npm and Corepack/pnpm can invoke these same scripts; dependency installation continues to use the pinned pnpm/uv locks.

The app uses `127.0.0.1`; `localhost` serves the separate Python runner. **System-wide certificate trust is optional and deferred by the owner.** The current HTTPS profile may still show a certificate warning and needs a site-specific browser exception where supported, including for the separate runner. The Run error help links to that runtime page. Reliable offline script caching needs browser-accepted HTTPS. No HTTP development profile has been added. The [optional HTTPS tools](docs/operations/local-https.md) prepare backed-up certificates (`tls:setup`), preview trust (`tls:trust`) and verify HTTPS plus OS trust (`tls:check`). Trust installation requires an explicit `tls:trust -- --install`. An untrusted-CA failure from `tls:check` is expected while installation is deferred and is separate from application readiness. See the [development guide](docs/operations/development-stack.md) for the account and M2 workbench walkthrough.

## Verification

```sh
corepack pnpm check
corepack pnpm api:check
corepack pnpm test
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .
uv run --locked --offline mypy
```

`pnpm check` covers ESLint, Prettier and root/workspace types; behavior is a separate gate. `api:check` regenerates schemas and declarations offline and rejects tracked drift. Generated contracts are intentionally versioned. Application/source checks use TypeScript 6.0.3; only the code-generation CLI has its required TypeScript 5.9.3 peer. See [API contract details](docs/api/README.md).

The full Python suite needs trusted PostgreSQL 18 tools and the installed Node workspace for binary-recovery tests. Native collaboration tests also use private disposable PostgreSQL clusters with TCP disabled:

```sh
export CODE_ALONG_POSTGRES_BIN=/absolute/path/to/postgresql-18/bin
uv run --locked --offline python -m pytest -q
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:integration
uv run --locked --offline python tools/dev/postgres_cluster.py -- \
  corepack pnpm --filter @code-along/collaboration test:transport
```

Use your own trusted installation path; see [native database prerequisites](docs/operations/postgres-tests.md). These harnesses never migrate an existing/reference database. `-m 'not postgres'` runs explicitly partial Python coverage and does not replace integration tests. Empty suites fail.

Verified maintenance provides graceful test-process cleanup, the normal npm development controller and optional local HTTPS tooling. The [database lifecycle guide](docs/operations/postgres-tests.md) records the reproduced direct-SIGTERM gap and the limits of cleanup after forced termination. OS trust installation remains deferred.

Build the owned browser fixtures and install Chromium/WebKit explicitly:

```sh
corepack pnpm --filter @code-along/browser-proofs exec playwright install chromium webkit
corepack pnpm --filter @code-along/web build
corepack pnpm --filter @code-along/runner-web build
corepack pnpm --filter @code-along/browser-proofs build
STORYBOOK_DISABLE_TELEMETRY=1 corepack pnpm --filter @code-along/design-system build-storybook
corepack pnpm --filter @code-along/browser-proofs test:browser
corepack pnpm --filter @code-along/browser-proofs test:foundation
# Also requires a trusted Redis 8 executable and PostgreSQL tools above:
export CODE_ALONG_REDIS_BIN=/absolute/path/to/redis-server
uv run --locked --offline python tools/dev/init_development.py
corepack pnpm --filter @code-along/browser-proofs test:product
```

OpenSSL and free loopback fixture ports are required: runner HTTPS 9443, UI 15173/15174, product HTTPS 18443/API 18001. Fixtures clean up their owned services and disposable databases/accounts; they do not use the persistent development database. The runner fixture removes its temporary TLS; the product fixture uses ignored development certificates and private fake-account mail, which remain local. On Linux, Playwright's `install --with-deps chromium webkit` also installs browser OS prerequisites; CI runs it on disposable runners.

| M2 local gate                                               | Result                                      |
| ----------------------------------------------------------- | ------------------------------------------- |
| Python configuration, backend, migration and recovery tests | 278 passed                                  |
| Regular JavaScript model/protocol/client tests              | 279 passed                                  |
| Native checkpoint storage / real-provider transport         | 20 / 13 passed                              |
| Chromium + WebKit runner / UI / product browser flows       | 26 / 4 / 50 passed                          |
| Lint, formatting, strict types, builds, locks and API drift | Passed                                      |
| npm audit and 59 exact backend/browser package entries      | No known advisories reported at review time |

[CI](.github/workflows/ci.yml) runs the foundation gates and a separate fresh Compose build/smoke test. The [M2 report](docs/architecture/m2-validation.md) records complete/focused local regressions, observed CI and limitations. Audits are point-in-time checks. Three scoped lint-tool minimatch overrides and one Storybook-docgen glob override remain until their parent packages update. Storybook's package-local `skipLibCheck` covers upstream declarations only; own source/stories remain strict.

Firefox is **unverified** on this workstation: its owned launcher fails before navigation with `Could not find profile folder`. `test:firefox` and `test:all` retain the explicit gate. Chromium/WebKit automation does not certify every retail/mobile browser or replace later screen-reader/load/deployment checks. The [M0 report](docs/architecture/m0-validation.md) and [runner threat model](docs/architecture/runner-threat-model.md) describe execution limits, including no hard browser memory quota or grade authority.

## Feature and operations guides

- [Accounts and private development email](docs/operations/authentication.md)
- [Workspaces and membership](docs/operations/workspaces.md)
- [Recipient-bound invitations](docs/operations/invitations.md)
- [Projects, starter files and sharing](docs/operations/projects.md)
- [Python execution, input/plots and warmed offline practice](docs/protocols/product-execution.md)
- [Local recovery and shared-device retention](docs/protocols/local-recovery.md)
- [Templates, source backups and local drafts](docs/protocols/project-tools.md)
- [Backend configuration and commands](docs/operations/backend-development.md)
- [Checkpoint protocol](docs/protocols/collaboration-checkpoints.md) and [persistence proof](docs/architecture/checkpoint-persistence-proof.md)

Production TLS/domains, SMTP delivery, HSTS, recovery/load/security review and deployment approval remain future operational work. Learner Python never executes in the API or ordinary application workers. Temporary keys, mail, environment files, volumes, caches, builds and test evidence remain ignored.

## Development workflow

Follow **PLAN → IMPLEMENT → TEST → REVIEW → SHOW CHANGES → APPROVAL → COMMIT → UPDATE PROGRESS → NEXT TASK**. Keep meaningful units separate, review the complete staged diff and preserve unrelated files. Normally, each commit needs approval; pushing, merging, deploying or changing accepted architecture also needs explicit authorization.

The owner authorized safe post-M2 storage/CI maintenance, a local M2 review and the complete approved M3 on 14 November 2026. Verified commits and pushes may proceed in coherent related feature bundles without repeated approval prompts. This scope ends after M3 and excludes architecture changes, merges, deployment, unrelated destructive actions and OS certificate-trust changes. A commit's hash is recorded in the next meaningful tracker update rather than amending history or creating a bookkeeping loop.

See [development storage and verification](docs/operations/development-resources.md) for the low-storage workflow and conservative prose-only CI path. Application, dependency, protocol and security changes retain full verification.

M2 delivers the multi-file IDE and isolated run experience. M3 integrates collaboration, durable saves and chat. M4 adds learning/submission/review workflows, M5 pilot readiness, and optional M6/M7 add trusted grading and extended collaboration. See the tracker for individual tasks and dependencies.

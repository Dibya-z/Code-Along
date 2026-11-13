# Code Along

Code Along is an independently implemented collaborative Python learning and development platform with its own UI and branding. The approved design combines shared multi-file programming, local Python practice, assignments, immutable submissions and instructor feedback.

## Current state

M0 integration proofs and M1 product foundation are implemented. You can register, verify an email locally, sign in, create a workspace, invite another account and create private projects with explicit editor/viewer access. The responsive React UI includes membership, sharing, ownership and file metadata controls. Starter source is currently read-only; the editor and Python run experience come in M2, followed by collaboration, durable saves and chat in M3. Nothing is deployed.

Open **https://127.0.0.1:8443** after starting the [local development stack](docs/operations/development-stack.md). This workstation uses the project-owned Lima VM; that guide includes its exact commands. Development verification/reset emails stay in a private local mail store, described in the [account guide](docs/operations/authentication.md).

- [Implementation tracker](IMPLEMENTATION_PROGRESS.md): milestones, dependencies, verification, commits and remaining work.
- [M1 validation report](docs/architecture/m1-validation.md): completed functionality, test evidence, CI and limitations.
- [Approved architecture](docs/architecture/approved-architecture.html): decisions, schema, protocols and roadmap. Open the HTML in a browser; some archived investigation links are machine-local.
- [Design direction](DESIGN.md) and [repository instructions](AGENTS.md).

## Architecture and implemented modules

| Responsibility              | Technology / boundary                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Product UI                  | React 19, TypeScript 6, Vite, React Router, TanStack Query                                      |
| Product APIs                | Python 3.13, Django 5.2 LTS, DRF, Channels/Daphne                                               |
| Identity                    | allauth headless, verified email, host-only Django sessions and CSRF                            |
| Durable storage             | PostgreSQL 18; Django owns product migrations                                                   |
| Transient coordination      | Redis; shared account/API abuse controls                                                        |
| Design system               | Original tokens, Radix-based primitives, Tailwind and Storybook                                 |
| API contracts               | Offline-generated OpenAPI and typed clients with CI drift checks                                |
| Editor/collaboration, M2/M3 | CodeMirror 6, Yjs and narrow Node/Hocuspocus service; integration proofs exist                  |
| Browser execution, M2       | Hash-pinned Pyodide in a separate-site supervised Worker; isolation proof exists                |
| Later trusted grading       | Separate Linux sandbox hosts and external scoring; never Django or ordinary application workers |

Workspace teaching roles do not grant access to private projects. Provider synchronization is not a durable save receipt. Browser practice is not a trusted grade. Runtime/framework/tool versions are exact in the lockfiles, and development base images use digest pins.

```text
apps/api/                 Django config, accounts, workspaces and projects
apps/web/                 React routes, feature screens and credential transport
apps/collaboration/       Binary checkpoint/transport proofs (M3 integration later)
apps/runner-web/          Separate-site supervised Pyodide Worker proof
packages/api-client/      Generated product/auth types and client factories
packages/contracts/       Versioned checkpoint and execution contracts
packages/design-system/   Original tokens, reusable controls and stories
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

| M1 final local gate                                         | Result                                      |
| ----------------------------------------------------------- | ------------------------------------------- |
| Python configuration, backend, migration and recovery tests | 203 passed                                  |
| Regular JavaScript protocol/client tests                    | 162 passed                                  |
| Native checkpoint storage / real-provider transport         | 20 / 13 passed                              |
| Chromium + WebKit runner / UI / product browser flows       | 26 / 4 / 8 passed                           |
| Lint, formatting, strict types, builds, locks and API drift | Passed                                      |
| npm audit and 58 exact public PyPI lock entries             | No known advisories reported at review time |

[CI](.github/workflows/ci.yml) runs the foundation gates and a separate fresh Compose build/smoke test. The [M1 report](docs/architecture/m1-validation.md) links the observed runs. Audits are point-in-time checks. Three scoped lint-tool minimatch overrides and one Storybook-docgen glob override remain until their parent packages update. Storybook's package-local `skipLibCheck` covers upstream declarations only; own source/stories remain strict.

Firefox is **unverified** on this workstation: its owned launcher fails before navigation with `Could not find profile folder`. `test:firefox` and `test:all` retain the explicit gate. Chromium/WebKit automation does not certify every retail/mobile browser or replace later screen-reader/load/deployment checks. The [M0 report](docs/architecture/m0-validation.md) and [runner threat model](docs/architecture/runner-threat-model.md) describe execution limits, including no hard browser memory quota or grade authority.

## Feature and operations guides

- [Accounts and private development email](docs/operations/authentication.md)
- [Workspaces and membership](docs/operations/workspaces.md)
- [Recipient-bound invitations](docs/operations/invitations.md)
- [Projects, starter files and sharing](docs/operations/projects.md)
- [Backend configuration and commands](docs/operations/backend-development.md)
- [Checkpoint protocol](docs/protocols/collaboration-checkpoints.md) and [persistence proof](docs/architecture/checkpoint-persistence-proof.md)

Production TLS/domains, SMTP delivery, HSTS, recovery/load/security review and deployment approval remain future operational work. Learner Python never executes in the API or ordinary application workers. Temporary keys, mail, environment files, volumes, caches, builds and test evidence remain ignored.

## Development workflow

Follow **PLAN → IMPLEMENT → TEST → REVIEW → SHOW CHANGES → APPROVAL → COMMIT → UPDATE PROGRESS → NEXT TASK**. Keep meaningful units separate, review the complete staged diff and preserve unrelated files. Normally, each commit needs approval; pushing, merging, deploying or changing accepted architecture also needs explicit authorization.

The owner authorized all M1 units and their verified granular commits/pushes in advance. That permission ends with M1; M2 requires a new instruction and ordinary review gates resume. A commit's hash is recorded in the next meaningful tracker update rather than amending history or creating a bookkeeping loop.

M2 builds the multi-file IDE and isolated run experience. M3 integrates collaboration, durable saves and chat. M4 adds learning/submission/review workflows, M5 pilot readiness, and optional M6/M7 add trusted grading and extended collaboration. See the tracker for individual tasks and dependencies.

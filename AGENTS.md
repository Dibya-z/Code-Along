# Repository Guidelines

## Role & Working Approach

Act as a senior software engineer and development partner. Inspect existing code and configuration before proposing changes. Explain important technical decisions, architectural tradeoffs, and assumptions. Work within the requested scope; do not begin application implementation until requested.

## Project Structure & Current State

The approved architecture is recorded in `docs/architecture/approved-architecture.html`; the task/dependency and commit tracker is `IMPLEMENTATION_PROGRESS.md`. M0 integration proofs and M1 product foundation are implemented. `apps/api` owns verified account sessions, workspaces, invitations, project/file metadata and explicit project access. `apps/web` contains the original responsive React UI; `packages/design-system` provides tokens/primitives/Storybook, and `packages/api-client` contains generated contracts/typed clients. Digest-pinned Compose provides persistent development PostgreSQL, Redis, private mail and an HTTPS app/separate-site runner. This workstation uses only the owned `.runtime/lima` VM; see `docs/operations/development-stack.md`. M0 checkpoint/transport/runner proofs remain distinct from the M2 editor/execution and M3 collaboration/durable-save/chat product integration. No deployment exists. Do not invent working commands; keep README and operations documentation aligned with verified behavior.

Follow the approved React/TypeScript/Vite frontend, CodeMirror/Yjs editor, Django/DRF/Channels product backend, narrow Node/Hocuspocus collaboration service, PostgreSQL durability and separate-site Pyodide Worker architecture. Redis is transient coordination; learner code must never execute in Django or ordinary Celery application workers. Exact versions and critical integrations require M0 verification. Obtain approval before changing accepted architecture.

Use the planned module boundaries when needed; do not create the entire target tree in advance. PyTogether is a read-only technical reference: author our own implementation, UI and branding. Preserve the ignored `.design-references/` library as local reference material.

Organize future modules by responsibility and follow the selected framework’s conventions. Keep business logic, presentation, persistence, and external integrations separate where applicable. Prefer clear module boundaries over premature abstractions.

## Coding Style & Architecture

Write clean, modular, scalable, and maintainable code using industry-standard conventions for the chosen language. Use descriptive names, consistent indentation, focused functions, and explicit interfaces. Introduce appropriate formatter and linter configuration when the stack is selected.

Favor simple solutions that meet current requirements. Avoid overengineering and unnecessary dependencies; justify new dependencies and significant architectural changes. Never modify unrelated files without explaining why the change is necessary.

## Development & Validation

Normal full-app development uses `npm run dev` (or the equivalent Corepack/pnpm root script), `npm run status`, `npm run mail -- --latest` and `npm run stop`. The foreground controller selects only the owned project engine, rejects duplicates and stops its services/dedicated Lima VM on ordinary shutdown while preserving data volumes. Do not bypass that controller with mixed Compose profiles while it is running. The watcher is private to Docker, with read-only source mounts and a same-origin HTTPS API/HMR proxy. Development nonces are replaced per response; static and runner CSPs retain their separate policies. Startup does not install OS certificate trust. The development browser gate requires an isolated test project/port and uses a dedicated CSS fixture rather than editing product source. Use separate test secrets/volumes and never run test cleanup against the primary application. See the development operations guide for these gates and practical limits.

Use Node 24.22.3 and the pinned pnpm through Corepack; follow the project-local cache/setup instructions in `README.md`. `corepack pnpm install --frozen-lockfile` installs tooling without lifecycle scripts; `corepack pnpm check` runs lint, format and root/workspace type checks. `corepack pnpm test` runs regular protocol/binary tests and excludes `*.integration.test.ts`. Run the collaboration integration script through the private PostgreSQL harness as documented; it is a separate required gate. Run test:transport through its own fresh harness as a separate gate; see docs/architecture/m0-validation.md for actual browser/restart evidence. Never bypass empty suites or equate fixture checks with product certification. The runner and browser fixture have build/test commands; Django check/migrate and Daphne development commands now exist; see docs/operations/backend-development.md. Keep package source/test type checks scoped to their environments; the contracts source has no Node-only runtime imports. Add checks with each new module rather than treating existing checks as whole-application verification.

Use the pinned Python interpreter and uv with the local cache instructions in `README.md`: `uv sync --locked --no-python-downloads`, `uv lock --check --offline`, `uv run --locked --offline ruff check .` and `uv run --locked --offline ruff format --check .`. `uv run --locked --offline python -m pytest -q` runs the Python suite, including real-cluster tests requiring CODE_ALONG_POSTGRES_BIN to point at matching stable PostgreSQL 18 tools. Use `-m "not postgres"` only for explicit unit-only coverage; never silently skip the integration gate. See `docs/operations/postgres-tests.md`. Never bypass empty suites or equate database-harness checks with CRDT persistence. Run `uv run --locked --offline mypy` for strict API source/test/entrypoint/fixture typing (generated migrations use actual migration/drift tests). `corepack pnpm api:check` regenerates product/allauth contracts offline and rejects drift; generated public contracts are intentionally tracked. Application source uses TypeScript 6; TypeScript 5 is isolated to the codegen CLI's declared peer. CI builds native services only in its owned prefix and runs separate disposable Compose checks; never point cleanup at the persistent development stack.

Work one logical unit at a time: PLAN → IMPLEMENT → TEST → REVIEW → SHOW CHANGES → APPROVAL → COMMIT → UPDATE PROGRESS → NEXT TASK. State the scope, dependencies and files before implementation. Fix failed checks before proceeding. Update the tracker after every meaningful unit with status, verification, known issues and actual approved commit hashes; do not mark planned functionality implemented.

Write tests for important functionality, including core behavior, meaningful edge cases, error paths, and bug regressions. Use descriptive test names and the project’s eventual testing conventions. Run relevant tests, linting, type checks, and builds when available. Review changes for errors and security vulnerabilities. Report validation performed, failures, and checks that could not run; never imply an unperformed check passed.

## Security & Configuration

Never hardcode secrets or credentials. Keep sensitive configuration outside source control, provide placeholder examples when needed, and ignore local environment files and generated artifacts. Validate untrusted input, handle errors safely, and review dependency and integration risks when relevant.

## Git & Delivery

The owner explicitly authorized M1.1–M1.8 and its final verified documentation handoff with granular commits/pushes, without per-unit prompts. M1 is complete; that permission does not extend to M2 or future work. Ordinary approval gates resume after this handoff. Architecture changes, destructive actions, merging and deployment always remain outside that milestone authorization.

During foundation work, a reviewable unit may normally group 2–3 closely related tasks. Declare the bundle scope first, implement and verify each task sequentially, then review the combined diff and request one commit approval. Choose boundaries by coherent purpose rather than a fixed task count. Keep substantial protocol, persistence, authentication and execution-security changes independently reviewable. Historical M0/M1 exceptions in the tracker do not authorize future milestones. Milestone order and separate push/merge/deployment approval requirements remain unchanged.

Before every commit, run relevant checks, review the diff for secrets/generated/unrelated files, verify only intended files are staged, and show the changed files and proposed conventional commit message. Wait for explicit approval before executing that commit. Commit each meaningful, independently verified unit rather than an entire milestone at once. Never push, merge or deploy without separate explicit approval.

After an approved commit, record its hash in the tracker; include that tracker change in the next approved unit rather than making an automatic bookkeeping commit or amendment. Preserve existing user changes and stage explicit paths, never blanket-add unrelated content. Keep changes focused and reviewable. When authorized, use concise, imperative conventional commit subjects. Pull requests should explain purpose, significant decisions, linked issues, and validation; include screenshots for visible interface changes.

## Collaboration Contract

The checkpoint v1 specification is `docs/protocols/collaboration-checkpoints.md`; the public package export is `@code-along/contracts/collaboration`. Preserve strict validation, frame/decoded-state limits and receipt correlation. Counter coverage includes remote and deletion-only updates; a state vector or synced event is insufficient. Parsers/matching helpers neither authorize callers nor prove a database transaction. Enforce those obligations at the admitted provider/persistence boundary in later units. Do not log source payloads or reflect validation input in errors. Any incompatible wire-contract change must be versioned and tested.

## Native Database Tests

The native harness is for trusted foreground tests on private disposable PostgreSQL 18 clusters. Never connect it to an external/shared database, reuse the reference runtime as an application DB or install a global service implicitly. Keep temporary builds/data/logs outside Git. Preserve disabled TCP, private directory/socket permissions, durability settings, version checks and process cleanup. Do not log SQL payloads from helper failures. Product schema/migrations remain owned by Django; harness probe tables are not application migrations.

## Checkpoint Storage Proof

The current CheckpointStore targets disposable checkpoint_proof fixture tables, not Django production migrations. Explicit checkpoints/autosaves must share the queue/CAS merge path. Keep state and receipt writes atomic and return receipts only after COMMIT. Preserve idempotency hashes/counters, generation checks, bigint string precision, defensive byte copies and generic driver errors. The caller owns authorization and bounded pool configuration/idle errors. Yjs validation uses pinned internal pending-fragment fields; upgrade only with compatibility tests. See `docs/architecture/checkpoint-persistence-proof.md` for limits and unverified transport/restart gates.

## M0 Runner and Design Boundaries

Read DESIGN.md and packages/design-system/src/tokens.css before product UI work. Apply Taste/web-design and the local Awesome DESIGN.md reference discipline without importing reference branding/assets. Token contrast tests do not replace rendered accessibility/keyboard/visual checks.

Execution v1 lives in packages/contracts/execution/runner.ts; preserve synchronous source capture, canonical hashes, strict nonce/run/field validation and budgets. The runner is a separate-site supervised Worker with no app credentials or parent-port exposure. Check CSP on the Worker response, not only shell HTML. Interactive stdin requires measured embedded SAB capability; batch fallback is explicit. Never weaken isolation to clear a browser test. Browser practice remains untrusted; no hard browser memory quota or authoritative grades are claimed.

The owned HTTPS/browser fixture is non-deployable and verifies runtime hashes before listening. test:browser explicitly targets Chromium/WebKit; test:firefox/test:all retain the unavailable Firefox gate, which currently fails before navigation. Do not silently skip it or claim retail/mobile certification. See docs/architecture/m0-validation.md for setup, evidence, limitations and production follow-ups. Python's binary recovery test requires the installed Node workspace in addition to native PostgreSQL 18.

## Django Foundation

The root and apps/api are non-packaged uv workspace projects sharing uv.lock; preserve no-build rather than enabling third-party source builds. manage.py and ASGI default to production settings; development is explicit and dotenv files are not loaded implicitly. Never add fallback credentials, wildcard production hosts, proxy-header trust or a SQLite test substitution. See docs/operations/backend-development.md and the placeholder apps/api/.env.example. Production HSTS/proxy/mail routing remains unfinished follow-up work; do not describe this as deployment ready.

AUTH_USER_MODEL is accounts.User and must precede any real migrate. Keep the UUID/email/display-name identity and framework password/session machinery; workspace roles and project access never come from a global learner/instructor flag. Django owns production migrations; M0 checkpoint_proof tables remain fixtures. Do not replace/delete reviewed migrations casually or migrate an external/reference database to run tests.

Backend PostgreSQL tests are marked postgres and use apps/api/conftest.py to allocate only an owned PG18 cluster/test database. Preserve Django's normalized TEST dictionary when changing connection settings. Config/HTTP/startup tests must not need an existing database. Health liveness does not prove DB/Redis readiness, and current product WebSockets are deliberately unimplemented/rejected. Never run learner Python in this API process.

## Product Foundation Boundaries

Use verified active sessions and CSRF on unsafe requests. Keep account responses private/no-store and clear identity-scoped frontend caches on session changes. Development email is private file delivery; production SMTP, domain/TLS/HSTS and deployment still need operational review. Never expose token-bearing messages, URLs, environments or resolved Compose credentials in shared logs.

Workspace roles and private project grants are independent. Re-check active membership for every project request; UUID knowledge and staff flags grant no bypass. Mutations lock workspace before project/invitation. Preserve owner-transfer/removal guards, digest-only recipient-bound invitation tokens, expiry and revocation/retry semantics. Workspace admins cannot inspect private project invitations. Keep the deferred parent/generation constraints and migration tests.

File metadata writes require explicit expected versions. Starter source is immutable M1 data, not an alternate REST live-save path. Rename preserves identity/generation; deleted entrypoints and invalid path/import collisions are rejected. New binary document state, collaboration leases and durable Saved receipts belong to M3. Read `docs/architecture/m1-validation.md` and the relevant operations guide before extending these policies. M2 has not started; obtain the owner's next instruction and follow ordinary commit/push approval gates after M1.

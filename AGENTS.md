# Repository Guidelines

## Role & Working Approach

Act as a senior software engineer and development partner. Inspect existing code and configuration before proposing changes. Explain important technical decisions, architectural tradeoffs, and assumptions. Work within the requested scope; do not begin application implementation until requested.

## Project Structure & Current State

The approved architecture is recorded in `docs/architecture/approved-architecture.html`; the task/dependency and commit tracker is `IMPLEMENTATION_PROGRESS.md`. The repository has approved documentation/hygiene commits and pinned root JavaScript tooling with a pnpm lockfile. Python 3.13.12/uv 0.10.9 tooling and a uv lockfile are now present as well. A portable checkpoint contract and real protocol tests exist in `packages/contracts/`; no application UI or running services exist yet. Do not invent working commands. Update `README.md` with actual verified setup as tooling is introduced.

Follow the approved React/TypeScript/Vite frontend, CodeMirror/Yjs editor, Django/DRF/Channels product backend, narrow Node/Hocuspocus collaboration service, PostgreSQL durability and separate-site Pyodide Worker architecture. Redis is transient coordination; learner code must never execute in Django or ordinary Celery application workers. Exact versions and critical integrations require M0 verification. Obtain approval before changing accepted architecture.

Use the planned module boundaries when needed; do not create the entire target tree in advance. PyTogether is a read-only technical reference: author our own implementation, UI and branding. Preserve the ignored `.design-references/` library as local reference material.

Organize future modules by responsibility and follow the selected framework’s conventions. Keep business logic, presentation, persistence, and external integrations separate where applicable. Prefer clear module boundaries over premature abstractions.

## Coding Style & Architecture

Write clean, modular, scalable, and maintainable code using industry-standard conventions for the chosen language. Use descriptive names, consistent indentation, focused functions, and explicit interfaces. Introduce appropriate formatter and linter configuration when the stack is selected.

Favor simple solutions that meet current requirements. Avoid overengineering and unnecessary dependencies; justify new dependencies and significant architectural changes. Never modify unrelated files without explaining why the change is necessary.

## Development & Validation

Use Node 24.22.3 and the pinned pnpm through Corepack; follow the project-local cache/setup instructions in `README.md`. `corepack pnpm install --frozen-lockfile` installs tooling without lifecycle scripts; `corepack pnpm check` runs lint, format and root/workspace type checks. `corepack pnpm test` runs real protocol tests; do not bypass empty suites or confuse contract tests with a server/database durability proof. There are no application start/build/migration commands yet. Keep package source/test type checks scoped to their environments; the contracts source has no Node-only runtime imports. Add checks with each new module rather than treating existing checks as whole-application verification.

Use the pinned Python interpreter and uv with the local cache instructions in `README.md`: `uv sync --locked --no-python-downloads`, `uv lock --check --offline`, `uv run --locked --offline ruff check .` and `uv run --locked --offline ruff format --check .`. `uv run --locked --offline pytest -q` returns exit 5 until Python tests exist. Never bypass the empty-suite exit or equate metadata-only lint checks with tested application behavior. Python framework/type-checker dependencies are deferred until actual source needs them.

Work one logical unit at a time: PLAN → IMPLEMENT → TEST → REVIEW → SHOW CHANGES → APPROVAL → COMMIT → UPDATE PROGRESS → NEXT TASK. State the scope, dependencies and files before implementation. Fix failed checks before proceeding. Update the tracker after every meaningful unit with status, verification, known issues and actual approved commit hashes; do not mark planned functionality implemented.

Write tests for important functionality, including core behavior, meaningful edge cases, error paths, and bug regressions. Use descriptive test names and the project’s eventual testing conventions. Run relevant tests, linting, type checks, and builds when available. Review changes for errors and security vulnerabilities. Report validation performed, failures, and checks that could not run; never imply an unperformed check passed.

## Security & Configuration

Never hardcode secrets or credentials. Keep sensitive configuration outside source control, provide placeholder examples when needed, and ignore local environment files and generated artifacts. Validate untrusted input, handle errors safely, and review dependency and integration risks when relevant.

## Git & Delivery

During foundation work, a reviewable unit may group 2–3 closely related tasks. Declare the bundle scope first, implement and verify each task sequentially, then review the combined diff and request one commit approval. Choose boundaries by coherent purpose rather than a fixed task count. Keep substantial protocol, persistence, authentication and execution-security changes independently reviewable. Milestone order and separate push/merge/deployment approval requirements remain unchanged.

Before every commit, run relevant checks, review the diff for secrets/generated/unrelated files, verify only intended files are staged, and show the changed files and proposed conventional commit message. Wait for explicit approval before executing that commit. Commit each meaningful, independently verified unit rather than an entire milestone at once. Never push, merge or deploy without separate explicit approval.

After an approved commit, record its hash in the tracker; include that tracker change in the next approved unit rather than making an automatic bookkeeping commit or amendment. Preserve existing user changes and stage explicit paths, never blanket-add unrelated content. Keep changes focused and reviewable. When authorized, use concise, imperative conventional commit subjects. Pull requests should explain purpose, significant decisions, linked issues, and validation; include screenshots for visible interface changes.

## Collaboration Contract

The checkpoint v1 specification is `docs/protocols/collaboration-checkpoints.md`; the public package export is `@code-along/contracts/collaboration`. Preserve strict validation, frame/decoded-state limits and receipt correlation. Counter coverage includes remote and deletion-only updates; a state vector or synced event is insufficient. Parsers/matching helpers neither authorize callers nor prove a database transaction. Enforce those obligations at the admitted provider/persistence boundary in later units. Do not log source payloads or reflect validation input in errors. Any incompatible wire-contract change must be versioned and tested.

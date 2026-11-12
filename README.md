# Code Along

Code Along is an independently implemented collaborative Python learning and development platform. The approved design combines shared multi-file editing with local Python practice, assignments, immutable submissions and instructor feedback, using original UI/UX and branding.

## Current state

Architecture approved on 13 November 2026. M0.1 recorded the design and development plan; M0.2 is establishing repository hygiene and tooling. The pinned JavaScript tooling is installed and verified. There is no application, database migration, runnable service or product test suite yet.

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

| Command                      | Current behavior                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm lint`         | Lints JavaScript/TypeScript with ESLint; warnings fail the check                                                                |
| `corepack pnpm format:check` | Checks formatting; excludes the archived architecture and generated lockfile                                                    |
| `corepack pnpm format`       | Formats supported repository files; review the diff before staging                                                              |
| `corepack pnpm typecheck`    | Checks the current Vitest config with the shared strict TypeScript baseline; package-specific checks arrive with their packages |
| `corepack pnpm check`        | Runs lint, format check and typecheck; does not claim product-test coverage                                                     |
| `corepack pnpm test`         | Runs Node-environment Vitest tests in apps/, packages/ and tests/; currently exits nonzero because no real tests exist yet      |

Do not use a pass-with-no-tests option to disguise the empty suite. M0.3 introduces the first protocol tests. During M0.2b verification, temporary fixtures demonstrated passing/failing assertions, lint errors, guarded/unguarded indexed access and format checks; these fixtures were removed. A clean cached frozen install was also verified, including rejection of a manifest/lock mismatch. This validates the toolchain, not application behavior.

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

Only root tooling exists. The workspace reserves apps/* and packages/* without creating empty application modules. No React, Hocuspocus, Yjs or database packages are installed yet; add them when the owning task needs them. Python setup follows in M0.2c. There are no application start, migration or build commands yet. macOS arm64 tooling was verified; other operating systems and browsers have not been tested.

No credentials belong in documentation or source control. PyTogether remains a read-only technical reference; its code, assets and branding are not imported into the application.

## Repository hygiene

`.gitignore` excludes local environment/credential files, dependency directories, virtual environments, caches, test reports, build outputs and local databases. Root `.env.example`, nested `.env.example`, `.env.test.example`, Python/JavaScript source and dependency lockfiles remain eligible for Git. Examples must contain placeholders only. Git ignore rules do not remove already tracked secrets; review the staged diff before each commit.

`.design-references/` remains an ignored local design library, preserved on disk and excluded from Git. It must not be included in future production images or asset bundles. The existing clone has not been imported or modified.

Use `git status --short`, `git diff --cached --check` and `git diff --cached` to inspect a proposed unit. A file being eligible for Git is not approval to include it.

## Development workflow

For each independently reviewable unit:

1. Plan its scope, dependencies, files and verification criteria.
2. Implement that unit and update its documentation/tracker.
3. Run relevant checks and review the complete diff, including intended staged files and secret/generated-file exclusions.
4. Show the proposed conventional commit message and changed files; wait for explicit approval.
5. Commit only the approved unit, record its hash in the tracker, then proceed to the next task.

Do not push, merge or deploy without separate explicit approval. Stop for approval before changing an accepted architectural decision.

The tracker distinguishes verified work from committed work. A commit cannot contain its own final hash: after an approved commit, record its hash in the next tracker update, to be included in the next approved unit. Never create an unapproved bookkeeping commit or amend a reviewed commit solely to insert that hash.

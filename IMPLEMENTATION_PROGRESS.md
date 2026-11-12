# Code Along implementation progress

Updated: 13 November 2026 (Asia/Kolkata).

## Approved baseline and tracking rules

The project owner approved the [architecture](docs/architecture/approved-architecture.html) on 13 November 2026. Follow that design, its release boundaries and its integration/security gates. Any architectural change requires approval before implementation. PyTogether is a read-only behavioral/source reference; implement Code Along independently.

Task and milestone status values: **Not Started**, **In Progress**, **Completed**, **Blocked**. Review/commit state is tracked separately. Verification can complete a task before commit approval. During foundation work, 2–3 closely related tasks normally form one reviewable unit: declare its scope, implement and verify each task sequentially, then request one approval for the combined commit. The next independent unit starts only after the current unit is verified, approved, committed and its progress recorded. Substantial protocol, persistence, authentication and execution-security changes remain separate; milestone order is unchanged. A blocked task must state the actual blocker; future dependencies alone are not failures.

The owner explicitly authorized completing the remaining M0 tasks as one bundle on 13 November 2026, after committing M0.4b. This exception preserves sequential task verification, final review/commit approval and separate push approval; future milestones retain granular units. Every task below is otherwise a candidate implementation unit, not permission to build an entire milestone at once. Group related small foundation tasks as described above, or break a task down further when it contains independently testable behavior. Commit boundaries follow coherent purpose rather than a fixed task count. Before each unit, state the exact files and checks. Use focused conventional commits, with explicit approval before each commit. No pushes, merges or deployments without separate explicit approval.

## Repository baseline

- Working repository: `Code-Along`; branch: `main`.
- Initial inspection: no commits/HEAD, no tracked files, no staged changes.
- Existing untracked content: `AGENTS.md` and `.design-references/awesome-design-md/`. Preserve both; neither belongs to the proposed M0.1 commit.
- Remote `origin` is configured. Local tracking reports `origin/main` unavailable; remote contents have not been fetched or verified. Do not infer that GitHub is empty.
- No application, lockfiles, test framework, environment configuration or runtime services exist in this repository.

## Milestone overview

| Milestone                               | Status      | Depends on                       | Exit gate                                                                                                |
| --------------------------------------- | ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0 — Baseline and integration proofs    | Completed   | Architecture approval (received) | Durable-save and isolated-runner compatibility demonstrated; exact dependencies and contracts documented |
| M1 — Product foundation and identity    | Not Started | M0                               | Two authenticated users can create/join scoped workspaces/projects; negative permission tests pass       |
| M2 — Multi-file Python IDE              | Not Started | M1; M0 runner proof              | Exact-source local runs, input/output and cancellation work with isolation and resource budgets          |
| M3 — Collaboration, durability and chat | Not Started | M2; M0 collaboration proof       | Concurrent/reconnect/crash save behavior and durable chat pass integration tests                         |
| M4 — Learning and instructor workflows  | Not Started | M3                               | Versioned assignments, exact-source submissions and scoped review/progress work                          |
| M5 — Pilot and operational readiness    | Not Started | M4                               | Measured load, accessibility, recovery and security checks pass; deployment requires separate approval   |
| M6 — Optional authoritative grading     | Not Started | M5; execution threat model       | Hostile remote-code isolation/scoring gate passes before enablement                                      |
| M7 — Extended collaborative learning    | Not Started | M5; feature-specific designs     | Each extension passes its own access/privacy/resource/reliability gate                                   |

Dependencies are explicit sequencing gates, not a request to implement tasks in parallel. M1–M5 form the first release; M6/M7 are later scope. Completing an earlier prototype does not complete its corresponding production feature.

## M0 — Baseline and integration proofs

Milestone status: **Completed** (implementation/proof gates verified for declared Chromium/WebKit baseline; final bundle commit approved; execution pending). Firefox launcher/support gate remains explicitly unverified.

| ID   | Task and sub-tasks                                                                                                                                | Depends on        | Status    | Verification / exit criteria                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0.1 | Record approved architecture; create README and complete implementation tracker; inspect/preserve Git baseline                                    | Approval received | Completed | Verified documentation, roadmap coverage and intended diff; committed as `6a38d54` after user approval                                                   |
| M0.2 | Add minimum workspace/tooling and safe ignore rules; verify installed prerequisites; select compatible patches and create locks for the proofs    | M0.1 committed    | Completed | Tooling sub-units verified and committed. Runtime integration proofs remain M0.3–M0.6.                                                                   |
| M0.3 | Define versioned collaboration checkpoint/receipt contract and focused test harness                                                               | M0.2              | Completed | Committed as `4819a2d` after approval; 122 protocol tests, clean install and source/test typechecks passed                                               |
| M0.4 | Prove Hocuspocus/Yjs binary persistence against PostgreSQL with serialized/CAS writes and atomic receipts                                         | M0.3              | Completed | Concurrent edits/deletes, duplicate requests, delayed stale save, reconnect and database/process failure tests; rejected writes receive no Saved receipt |
| M0.5 | Define runner threat model, manifest/message contract, supported-browser matrix and separate-site test environment                                | M0.4              | Completed | Origin/cookie/CSP/iframe/Worker boundaries and explicit browser support/fallback criteria documented                                                     |
| M0.6 | Prove pinned Pyodide Worker startup, stdin/stdout, fresh-run state and hard cancellation across runner boundary                                   | M0.5              | Completed | Exact snapshot runs; chunked output/input/infinite-loop cases; no credential bridge; browser/header results recorded honestly                            |
| M0.7 | Define original design direction, semantic tokens, accessibility/responsive criteria and architecture decision records; consolidate proof results | M0.6              | Completed | DESIGN.md and accepted contracts/version choices reflect measured compatibility; seek approval for any architecture change                               |

Initial implementation sequence after the documentation commit: **M0.2 → M0.3 → M0.4**. Do not start production identity/editor implementation before the critical compatibility gates. Proof code should live in the owning planned modules and be clearly identified as a harness, not shipped product functionality.

## M1 — Product foundation and identity

Milestone status: **Not Started**.

| ID   | Task and sub-tasks                                                                                                                     | Depends on | Status      | Verification / exit criteria                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------- |
| M1.1 | Django modular backend, initial custom user model before first auth migrations, validated settings, ASGI and safe environment examples | M0         | Not Started | Startup/configuration failure cases and clean database migration checks                        |
| M1.2 | Reproducible Compose stack, same-origin proxy, isolated runner-site routing, documented native fallback and health checks              | M1.1       | Not Started | Documented fresh setup works; services agree on storage/hosts; secrets excluded from images    |
| M1.3 | React routing/providers, typed API/CSRF client, design primitives and Storybook                                                        | M1.2       | Not Started | Type/lint/component checks, keyboard/focus states and error boundaries                         |
| M1.4 | User authentication/session flows, registration/verification, login/logout and password reset                                          | M1.3       | Not Started | Session/CSRF/Origin/expiry tests, rate limits and non-disclosing reset behavior                |
| M1.5 | Workspace/membership/ownership schema, policies and create/list/update interfaces                                                      | M1.4       | Not Started | Migrations, policy matrix, membership removal and ownership-transfer tests                     |
| M1.6 | Expiring invitations, acceptance/revocation and scoped membership UI                                                                   | M1.5       | Not Started | Digest storage, recipient/expiry/use limits and retry/race tests                               |
| M1.7 | Project/file metadata, initial document records, explicit grants and policy-controlled APIs/UI                                         | M1.6       | Not Started | Atomic creation; parent association, traversal/collision/quota and cross-tenant negative tests |
| M1.8 | API schema generation, CI gates and foundation end-to-end flow                                                                         | M1.7       | Not Started | Two users authenticate/create/join only allowed resources; CI checks introduced functionality  |

Each schema/migration, API behavior and associated UI may be split into separate verified units when appropriate; do not combine M1 into one commit.

## M2 — Single-user multi-file Python IDE

Milestone status: **Not Started**.

| ID   | Task and sub-tasks                                                                                    | Depends on | Status      | Verification / exit criteria                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------- |
| M2.1 | File tree/tabs, stable CodeMirror controllers, entrypoint and metadata operations                     | M1         | Not Started | Rename/delete/entrypoint policies; rerenders do not reset editor or lose content                           |
| M2.2 | Immutable versioned RunManifest and synchronous source capture/hash                                   | M2.1       | Not Started | Complete file set, generations, exact bytes and runtime identity; later edits cannot mutate captured input |
| M2.3 | Production runner supervisor/bridge, pinned lazy runtime profiles and fresh VFS/interpreter lifecycle | M2.2       | Not Started | Separate origin and validated messages; multi-file imports; no leaked globals/credentials                  |
| M2.4 | Safe sequenced console/stdin, output limits and run-state UI                                          | M2.3       | Not Started | Chunk boundaries, delayed messages, input fallback, errors, raster plots and source-version labels         |
| M2.5 | Stop/timeout/Worker replacement and resource-budget behavior                                          | M2.4       | Not Started | Infinite loops, late output and repeated cancellation yield one terminal state per run                     |
| M2.6 | Account-scoped local recovery, shared-device logout policy, templates and import/export               | M2.5       | Not Started | Recovery/offline completeness, unsafe paths, archive limits and logout cases; no false server-save claim   |

## M3 — Reliable collaboration, durable saves and chat

Milestone status: **Not Started**.

| ID   | Task and sub-tasks                                                                                         | Depends on | Status      | Verification / exit criteria                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- | ---------- | ----------- | ----------------------------------------------------------------------------------------------- |
| M3.1 | Production collaboration service, restricted database role and exactly-once binary document initialization | M2; M0.4   | Not Started | Concurrent cold starts, binary recovery and no plaintext reseeding on reconnect                 |
| M3.2 | One-use per-document tickets, identity/Origin checks, read/write scope, leases and revocation              | M3.1       | Not Started | Wrong scope/generation/user rejected; fail-closed lease expiry; multi-document admission works  |
| M3.3 | Multi-user Yjs bindings, awareness/cursors/selections and multi-tab presence                               | M3.2       | Not Started | Independent clients converge, including empty/short documents; no spoofed identity              |
| M3.4 | Production checkpoint persistence, atomic receipts, backpressure and honest Saved UI                       | M3.3       | Not Started | Delete-only, idempotent retry, stale autosave/CAS merge and DB outage/crash tests               |
| M3.5 | Reconnect/local reconciliation, generation conflicts and recovery/export                                   | M3.4       | Not Started | Network partitions, revoked access, replaced/deleted files and pending local work               |
| M3.6 | Named immutable revisions, explicit snapshot/live shares, expiry/revocation and copy-from-history          | M3.5       | Not Started | Frozen bytes retained; receipt alone cannot retrieve history; share scope and access tests      |
| M3.7 | Versioned Channels events, transactional outbox and replay/refresh strategy                                | M3.6       | Not Started | Missing/duplicate events, process failure after commit and dispatcher retry tests               |
| M3.8 | Persisted UTC chat, nonce deduplication, paginated history and pending-message UI                          | M3.7       | Not Started | Retry/reconnect/capacity-loss cases; no timestamp or duplicated-bubble regression               |
| M3.9 | Full collaboration regression gate                                                                         | M3.8       | Not Started | Rapid edit → Run → reload, settled save, restart, multi-tab and permission-revocation scenarios |

## M4 — Learning and instructor workflows

Milestone status: **Not Started**.

| ID   | Task and sub-tasks                                                                                      | Depends on | Status      | Verification / exit criteria                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------- | ----------- | -------------------------------------------------------------------------------------------- |
| M4.1 | Assignment/version schema, authoring, instructions and immutable starter policy                         | M3         | Not Started | Publication/versioning, scoped authoring and historical consistency                          |
| M4.2 | Assignment participation/teams, invitations/consent and instructor-controlled eligibility               | M4.1       | Not Started | No arbitrary participant lists or automatic inclusion of project viewers/mentors             |
| M4.3 | Learning session UI, staged hints and visible checks                                                    | M4.2       | Not Started | Accessible instructions/hints; practice results labeled untrusted and tied to manifest       |
| M4.4 | Exact-version immutable submission transaction, frozen participants, deadlines, budgets and idempotency | M4.3       | Not Started | Submit tested H after live H2; server hashes bytes and rechecks eligibility/access at commit |
| M4.5 | Submission-owned artifact access, review/source viewer and instructor feedback                          | M4.4       | Not Started | Project owners/shares gain no implicit submission access; reviewer sees frozen source        |
| M4.6 | Derived progress, assessment status and notifications                                                   | M4.5       | Not Started | Client cannot assign trusted scores; feedback/progress recover from missed events            |

## M5 — Pilot and operational readiness

Milestone status: **Not Started**.

| ID   | Task and sub-tasks                                                            | Depends on | Status      | Verification / exit criteria                                                                           |
| ---- | ----------------------------------------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| M5.1 | Browser/accessibility/responsive and complete learner/instructor QA           | M4         | Not Started | Supported matrix, focus/keyboard/reduced-motion and essential workflows pass                           |
| M5.2 | Load/resource profiling, quotas and bottleneck fixes                          | M5.1       | Not Started | Measure proposed 2–6 editors/room and 30 learners/workspace; publish results, not assumed guarantees   |
| M5.3 | Metrics/traces/alerts, audit/retention policy and incident procedures         | M5.2       | Not Started | Checkpoint lag/outbox age/errors visible; no credentials/source in routine logs                        |
| M5.4 | Backup/restore, drain/restart and migration/rollback exercises                | M5.3       | Not Started | Restore project/submission data; no overlapping collaboration writers; documented recovery limitations |
| M5.5 | Threat-model regression, dependency review and first-release readiness report | M5.4       | Not Started | Authorization/output/runner/abuse checks pass; unresolved risks stated explicitly                      |
| M5.6 | Prepare reviewed deployment configuration/runbook and controlled pilot        | M5.5       | Not Started | Separate explicit deployment approval before any deployment; observed pilot results recorded           |

## M6 — Optional authoritative server assessment

Milestone status: **Not Started**. Feature stays disabled until all execution-security gates pass.

| ID   | Task and sub-tasks                                                                      | Depends on | Status      | Verification / exit criteria                                                                      |
| ---- | --------------------------------------------------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------- |
| M6.1 | Execution threat model, native runtime semantics and versioned black-box test policy    | M5         | Not Started | Browser/native differences and hidden-input/feedback limitations documented                       |
| M6.2 | Dedicated Linux runner provisioning and gVisor controller                               | M6.1       | Not Started | No network/app credentials/host mounts/socket/capabilities; read-only root and disposable scratch |
| M6.3 | Immutable artifact jobs, atomic quota reservation, idempotent dispatch and cancellation | M6.2       | Not Started | External CPU/RAM/PID/wall/output enforcement; retry/kill/cleanup tests                            |
| M6.4 | External trusted scoring, versioned evaluation and filtered learner feedback            | M6.3       | Not Started | Student output cannot forge a grade; expected outputs stay outside sandbox                        |
| M6.5 | Adversarial isolation, leakage, load and recovery gate                                  | M6.4       | Not Started | Security evidence reviewed before explicit enablement/deployment approval                         |

## M7 — Extended collaborative learning

Milestone status: **Not Started**. Prioritize extensions after pilot evidence; do not treat this list as a mandatory single release.

| ID   | Task and sub-tasks                                               | Depends on                                | Status      | Verification / exit criteria                                                            |
| ---- | ---------------------------------------------------------------- | ----------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| M7.1 | Durable collaborative board and source-linked discussion         | M5; approved feature design               | Not Started | Separate bounded board document, persisted recovery and scoped access                   |
| M7.2 | Voice signaling, TURN support and device/privacy controls        | M5; approved feature design               | Not Started | Real connectivity/mute/leave/revocation tests; mesh versus SFU based on room needs      |
| M7.3 | Instructor presentation/follow controls and threaded review      | M5; approved feature design               | Not Started | Explicit consent/control and existing project privacy preserved                         |
| M7.4 | Lesson sequences, rubrics and privacy-aware analytics            | M5; approved feature design               | Not Started | Versioned learning records, understandable progress and minimization/retention          |
| M7.5 | Git integration and larger project/data workflows                | M5; approved feature design               | Not Started | Narrow credential scope, conflict handling and bounded import/export                    |
| M7.6 | Measured collaboration sharding or additional execution profiles | M5; demonstrated need and approved design | Not Started | Ownership fencing/split-brain recovery or profile-specific security/compatibility gates |

## M0.2 implementation units

M0.2 is split into independently verified commits. All three sub-units are implemented, verified, committed and pushed. Repository hygiene alone did not establish reproducible dependency installs; the JavaScript/Python checks below complete that tooling gate.

| Unit  | Scope                                                                                       | Depends on      | Status    | Review / verification                                                                                         |
| ----- | ------------------------------------------------------------------------------------------- | --------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| M0.2a | Git exclusions, current repository guidance, README/tracker updates                         | M0.1 committed  | Completed | Committed as `a44ba44` after approval; 66 ignore-policy checks passed                                         |
| M0.2b | Minimum pnpm workspace and JavaScript collaboration-proof tooling with exact versions/locks | M0.2a committed | Completed | Committed as `f1a18e7` after approval; frozen install, quality checks and tool positive/negative cases passed |
| M0.2c | Minimum Python tooling/lock and documented prerequisites for later Django/runner work       | M0.2b committed | Completed | Committed as `3a73db2` after approval; locked install and Ruff/pytest positive/negative cases passed          |

## Remaining M0 implementation bundle

The owner requested one completion bundle after the approved M0.4b commit. Dependencies were implemented and verified sequentially; commits/pushes still need explicit approval.

| Unit  | Scope                                                                                        | Status    | Evidence                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| M0.4a | Disposable PostgreSQL 18 harness                                                             | Completed | `910a4e3`, already approved/pushed                                                                                                      |
| M0.4b | Binary persistence and atomic receipts                                                       | Completed | `e7ee8f4`, approved/committed; not pushed                                                                                               |
| M0.4c | Hocuspocus/provider adapter, checkpoint controller, transport/restart/fault proof            | Completed | 13 real-provider/PG cases; process SIGKILL recovery; fresh Node process after actual PostgreSQL immediate shutdown/WAL recovery         |
| M0.5  | Threat model, strict execution/manifest contracts, two-site test topology and browser matrix | Completed | Versioned/hash-verified immutable source; nonce/run/capability validation; explicit no-credential boundary and fallback                 |
| M0.6  | Pinned Pyodide Worker proof and browser/CodeMirror integration                               | Completed | 13 browser cases per measured engine; fresh interpreter/files, stdin/stdout, isolation/negative cases, hard Stop/deadline/output limits |
| M0.7  | Original design direction, semantic tokens, ADRs and proof consolidation                     | Completed | DESIGN.md, light/dark contrast checks, decisions and M0 validation report                                                               |

## Current unit: remaining M0 bundle

- Task status: **Completed**; final bundle commit approved; execution pending. M1 is **Not Started**.
- New scope: collaboration transport/controller and fixtures, binary DB-restart probe, execution contracts/tests, isolated runner, owned browser tests/HTTPS fixture, hash inventory, original design tokens/DESIGN.md, architecture decisions and consolidated proof report.
- Existing files updated: workspace/lock/configuration, shared exports/typecheck scopes, README, AGENTS, tracker and existing proof operations documentation.
- Verification: 153 regular JavaScript tests, 20 native storage cases, 13 native transport cases, 29 Python tests; Chromium 158.0.8127.18 and WebKit 27.2 exercised across the declared 13-case runner matrix. Lint/format/source/test type checks, both fixture builds, runtime asset hashes and dependency audit passed. Clean frozen offline six-workspace install, builds, regular/native tests, native source imports and lock preservation also passed; a mismatched runtime hash was rejected and temporary TLS cleanup verified.
- Measured browser scope: embedded SAB/interactive stdin and explicit non-isolated batch fallback pass in Chromium and WebKit. Firefox 159.0 installation succeeded but its owned launcher cannot find fresh profile directories in three tested locations; no Firefox runtime support is claimed. `test:firefox` and `test:all` remain visible gates. Retail/mobile/product certification remains M2/M5.
- Schema/security boundary: all DDL/admission/HTTPS routing is test-only. No real auth, production migrations, public collaboration server, deployable runtime asset packaging, grade authority or hard browser memory quota. No reference code/branding copied or reference repository changed. See `docs/architecture/m0-validation.md` for evidence and limitations.
- Proposed commit: `completed M0 foundation`.
- Review state: **Approved by the user** with exact message `completed M0 foundation`; execution pending. The user authorized the M0.4b commit, which is now `e7ee8f499031ff0166285965f635b50cae088bab`. Push is reserved for the user to execute manually; no push, merge or deployment performed. Last pushed hash remains `910a4e330d31abf287aa422757693cc9b5bd7be5`.
- Next unit after approval/commit/progress update: M1.1, Django foundation and initial custom user before auth migrations. Do not start it as part of the M0 bundle.

## Commit ledger

| Unit         | Commit                                     | Review state                                                                                    |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| M0.1         | `6a38d545ffee3381bc15f9d03ac32706ef657153` | Committed after explicit user approval; documentation checks passed                             |
| M0.2a        | `a44ba44835b37e1ad5a8d92ef136bc4c3f053d11` | Committed after explicit approval; hygiene checks passed                                        |
| M0.2b        | `f1a18e7374878c439ae46c732861c07df157c5c9` | Committed after explicit approval; pushed with M0.1/M0.2a on explicit authorization             |
| M0.2c        | `3a73db2465cb6a8a22a90d29f83ff3685d2c6673` | Committed after explicit approval; Python tooling verified; pushed with M0.4a                   |
| M0.3         | `4819a2d328affa4a2bfa6b989898349dc229e354` | Committed after explicit approval; contract checks passed; pushed with M0.4a                    |
| M0.4a        | `910a4e330d31abf287aa422757693cc9b5bd7be5` | Committed and pushed after explicit authorization; 28 Python/122 protocol tests passed          |
| M0.4b        | `e7ee8f499031ff0166285965f635b50cae088bab` | Committed after explicit approval; verified persistence proof; not pushed                       |
| M0 remainder | Pending commit                             | M0.4c/M0.5/M0.6/M0.7 bundle explicitly approved as `completed M0 foundation`; execution pending |

After an approved commit, replace the pending entry with its actual hash. A commit cannot contain its own final hash: record that hash in the next tracker change and include it in the next approved unit. Do not amend commits or create automatic bookkeeping commits. Record completed units, tests and remaining issues before presenting each subsequent commit.

## Pending work, known issues and technical debt

- Commits through M0.4a are pushed and verified at `910a4e3`. M0.4b (`e7ee8f4`) is local only. The remaining M0 bundle is verified but not committed. Never infer push permission from milestone implementation authorization.
- Firefox's installed owned engine cannot find fresh profile folders here. Its suite is unverified, not skipped/passed; fix the launcher and execute all cases before claiming support. Chromium/WebKit results do not certify retail browsers, mobile or deployed headers.
- No product app/API, identity, migrations, real admission/revalidation/revocation or UI flows exist. M1 begins the product foundation. Later provider/UI, persistent chat, revisions, submission, learning and operations milestones retain their original gates.
- The `checkpoint_proof` schema is disposable fixture DDL, not Django production mapping/history/retention. The one-instance proof is not multi-writer sharding, capacity testing, backup/restore or zero loss of unacknowledged edits. Yjs pending-fragment checks use pinned internals; upgrades need compatibility tests.
- PostgreSQL 18.7 was built in an external private temporary prefix. It is not a global service, may disappear, and must be replaced with a trusted native toolset to rerun tests. Docker/Redis are not available on the current PATH; Compose and image pins belong to M1.2. Python's binary-recovery test now requires installed Node workspace dependencies.
- Runner asset hashes are verified by the fixture, which serves the pinned package's assets. The shell build is not a deployable distribution; production packaging, distinct domains/TLS/cookie/header policies and resource controls remain M1/M2. Browser Workers cannot enforce a hard memory quota, and practice feedback can be forged. Extra packages, plots/data export and server grading remain disabled/not implemented.
- Proof-stage state/source/queue/deadline limits are measured test controls, not security/capacity guarantees. Declared 2–6 editors/room and 30 learners/workspace targets require later load tests. Authentication leases, privacy/retention and deployed-browser security gates are unresolved product work.
- DESIGN.md/tokens are original source, not completed product UI. Storybook, keyboard/screen-reader/responsive checks and rendered design approval remain M1.3/M5. Reference design files are ignored/preserved and not vendored; do not add assets without licensing review.
- Framework versions not exercised by M0 and deployment image digests are selected/verified in their owning M1 unit. Python framework/type checking is deferred until backend source exists. The approved architecture HTML and existing PyTogether source remain unchanged.
- Remove the three scoped minimatch 11.0.1 overrides after their lint-tool parents adopt patched versions, then rerun checks/audit. Current dependency audit has no known advisories; that is a point-in-time result, not a security guarantee.
- Historical links in archived architecture may refer to unavailable machine-local investigation artifacts. Repository-hosted decisions and proof reports are the current portable evidence.

# Code Along implementation progress

Updated: 13 November 2026 (Asia/Kolkata).

## Approved baseline and tracking rules

The project owner approved the [architecture](docs/architecture/approved-architecture.html) on 13 November 2026. Follow that design, its release boundaries and its integration/security gates. Any architectural change requires approval before implementation. PyTogether is a read-only behavioral/source reference; implement Code Along independently.

Task and milestone status values: **Not Started**, **In Progress**, **Completed**, **Blocked**. Review/commit state is tracked separately. Verification can complete a task before commit approval. During foundation work, 2–3 closely related tasks may form one reviewable unit: declare its scope, implement and verify each task sequentially, then request one approval for the combined commit. The next independent unit starts only after the current unit is verified, approved, committed and its progress recorded. Substantial protocol, persistence, authentication and execution-security changes remain separate; milestone order is unchanged. A blocked task must state the actual blocker; future dependencies alone are not failures.

Every task below is a candidate implementation unit, not permission to build an entire milestone at once. Group related small foundation tasks as described above, or break a task down further when it contains independently testable behavior. Commit boundaries follow coherent purpose rather than a fixed task count. Before each unit, state the exact files and checks. Use focused conventional commits, with explicit approval before each commit. No pushes, merges or deployments without separate explicit approval.

## Repository baseline

- Working repository: `Code-Along`; branch: `main`.
- Initial inspection: no commits/HEAD, no tracked files, no staged changes.
- Existing untracked content: `AGENTS.md` and `.design-references/awesome-design-md/`. Preserve both; neither belongs to the proposed M0.1 commit.
- Remote `origin` is configured. Local tracking reports `origin/main` unavailable; remote contents have not been fetched or verified. Do not infer that GitHub is empty.
- No application, lockfiles, test framework, environment configuration or runtime services exist in this repository.

## Milestone overview

| Milestone                               | Status      | Depends on                       | Exit gate                                                                                                |
| --------------------------------------- | ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| M0 — Baseline and integration proofs    | In Progress | Architecture approval (received) | Durable-save and isolated-runner compatibility demonstrated; exact dependencies and contracts documented |
| M1 — Product foundation and identity    | Not Started | M0                               | Two authenticated users can create/join scoped workspaces/projects; negative permission tests pass       |
| M2 — Multi-file Python IDE              | Not Started | M1; M0 runner proof              | Exact-source local runs, input/output and cancellation work with isolation and resource budgets          |
| M3 — Collaboration, durability and chat | Not Started | M2; M0 collaboration proof       | Concurrent/reconnect/crash save behavior and durable chat pass integration tests                         |
| M4 — Learning and instructor workflows  | Not Started | M3                               | Versioned assignments, exact-source submissions and scoped review/progress work                          |
| M5 — Pilot and operational readiness    | Not Started | M4                               | Measured load, accessibility, recovery and security checks pass; deployment requires separate approval   |
| M6 — Optional authoritative grading     | Not Started | M5; execution threat model       | Hostile remote-code isolation/scoring gate passes before enablement                                      |
| M7 — Extended collaborative learning    | Not Started | M5; feature-specific designs     | Each extension passes its own access/privacy/resource/reliability gate                                   |

Dependencies are explicit sequencing gates, not a request to implement tasks in parallel. M1–M5 form the first release; M6/M7 are later scope. Completing an earlier prototype does not complete its corresponding production feature.

## M0 — Baseline and integration proofs

Milestone status: **In Progress**.

| ID   | Task and sub-tasks                                                                                                                                | Depends on        | Status      | Verification / exit criteria                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0.1 | Record approved architecture; create README and complete implementation tracker; inspect/preserve Git baseline                                    | Approval received | Completed   | Verified documentation, roadmap coverage and intended diff; committed as `6a38d54` after user approval                                                   |
| M0.2 | Add minimum workspace/tooling and safe ignore rules; verify installed prerequisites; select compatible patches and create locks for the proofs    | M0.1 committed    | Completed   | Tooling sub-units verified and committed. Runtime integration proofs remain M0.3–M0.6.                                                                   |
| M0.3 | Define versioned collaboration checkpoint/receipt contract and focused test harness                                                               | M0.2              | Completed   | Committed as `4819a2d` after approval; 122 protocol tests, clean install and source/test typechecks passed                                               |
| M0.4 | Prove Hocuspocus/Yjs binary persistence against PostgreSQL with serialized/CAS writes and atomic receipts                                         | M0.3              | In Progress | Concurrent edits/deletes, duplicate requests, delayed stale save, reconnect and database/process failure tests; rejected writes receive no Saved receipt |
| M0.5 | Define runner threat model, manifest/message contract, supported-browser matrix and separate-site test environment                                | M0.4              | Not Started | Origin/cookie/CSP/iframe/Worker boundaries and explicit browser support/fallback criteria documented                                                     |
| M0.6 | Prove pinned Pyodide Worker startup, stdin/stdout, fresh-run state and hard cancellation across runner boundary                                   | M0.5              | Not Started | Exact snapshot runs; chunked output/input/infinite-loop cases; no credential bridge; browser/header results recorded honestly                            |
| M0.7 | Define original design direction, semantic tokens, accessibility/responsive criteria and architecture decision records; consolidate proof results | M0.6              | Not Started | DESIGN.md and accepted contracts/version choices reflect measured compatibility; seek approval for any architecture change                               |

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

## M0.4 implementation units

Keep the database prerequisite, persistence writer and transport/fault proof independently reviewable. M0.4a is committed; M0.4b is the current scope.

| Unit  | Scope                                                                                                        | Depends on      | Status      | Verification gate                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------ | --------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| M0.4a | Disposable PostgreSQL 18 test-cluster harness, lifecycle/error tests and verified native setup documentation | M0.3 committed  | Completed   | Committed as `910a4e3`; 28 Python/122 protocol tests passed; pushed after explicit approval                                   |
| M0.4b | Serialized binary checkpoint persistence and atomic receipt/idempotency storage proof                        | M0.4a committed | Completed   | 133 regular JS tests and 20 real PG18 integration cases verified; clean install/native import passed; commit approval pending |
| M0.4c | Hocuspocus/provider adapter and concurrent/reconnect/crash/security transport proof                          | M0.4b committed | Not Started | No peer-forged receipts, rejected writes never accepted, init/restart/cold-start/failure evidence                             |

## Current unit: M0.4b

- Task status: **Completed** (storage proof verified; commit approval pending).
- Bundle: binary source validation/serialized writer, atomic PostgreSQL receipt/idempotency behavior, and real transaction/concurrency/failure tests.
- New files: collaboration package/tsconfig/integration config, `src/persistence/binary-state.ts`, `src/persistence/checkpoint-store.ts`, binary unit tests, checkpoint integration tests, test-only `schema.sql`, and `docs/architecture/checkpoint-persistence-proof.md`.
- Updated files: root lock/test configuration, README, AGENTS and tracker (including the prior approved M0.4a hash/status update).
- Implemented behavior: validated source-only binary state, immutable input capture/defensive copies, canonical seed-once initialization, shared per-document queues, bounded CAS reload/merge, atomic state/receipt commits, retry/conflict/retention semantics, generation/checksum checks, bigint precision and generic driver failure handling with broken-client disposal.
- Verification: 133 regular JS tests (122 prior protocol + 11 binary cases), 20 real PostgreSQL 18.7 cases (forced CAS overlap, deferred COMMIT visibility, insert/commit failure rollback, killed backend/retry, stale deleted-source autosave, initialization races, lost-response retry, conflicting keys, pruning, bigint, corruption, grants and queue capacity); lint/format/source/test types; clean cached three-package install and repeated tests; native Node source import. npm audit reported no known vulnerabilities. All 28 existing Python harness tests passed as well.
- Schema boundary: fixture DDL only; Django still owns production schema/migrations and the generation/history/retention model. No public server, provider adapter or learner authorization implemented. No application port opened; all DB tests use owned temporary Unix-socket clusters.
- Limits: proof-stage state/structure/queue/retry/time budgets are not capacity/security guarantees. Yjs pending-fragment validation uses pinned internals. A reconstructed object is not process restart; Hocuspocus, network ordering, auth/revocation and actual process/DB restart remain M0.4c/M3.
- Proposed commit: `feat: persist code checkpoints`.
- Review state: **Awaiting user approval**. No new commit, push, merge or deployment performed. M0.4a remains the last approved/pushed commit: `910a4e330d31abf287aa422757693cc9b5bd7be5`.
- Next unit after approval/commit/progress update: **M0.4c**, provider integration and transport/restart/failure proof. M0.4 remains In Progress.

## Commit ledger

| Unit  | Commit                                     | Review state                                                                           |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| M0.1  | `6a38d545ffee3381bc15f9d03ac32706ef657153` | Committed after explicit user approval; documentation checks passed                    |
| M0.2a | `a44ba44835b37e1ad5a8d92ef136bc4c3f053d11` | Committed after explicit approval; hygiene checks passed                               |
| M0.2b | `f1a18e7374878c439ae46c732861c07df157c5c9` | Committed after explicit approval; pushed with M0.1/M0.2a on explicit authorization    |
| M0.2c | `3a73db2465cb6a8a22a90d29f83ff3685d2c6673` | Committed after explicit approval; Python tooling verified; pushed with M0.4a          |
| M0.3  | `4819a2d328affa4a2bfa6b989898349dc229e354` | Committed after explicit approval; contract checks passed; pushed with M0.4a           |
| M0.4a | `910a4e330d31abf287aa422757693cc9b5bd7be5` | Committed and pushed after explicit authorization; 28 Python/122 protocol tests passed |
| M0.4b | Pending approval                           | Proposed binary checkpoint persistence bundle; not executed                            |

After an approved commit, replace the pending entry with its actual hash. A commit cannot contain its own final hash: record that hash in the next tracker change and include it in the next approved unit. Do not amend commits or create automatic bookkeeping commits. Record completed units, tests and remaining issues before presenting each subsequent commit.

## Pending work, known issues and technical debt

- All approved commits through M0.4a are pushed to `origin/main`, verified at `910a4e3`. M0.2/M0.3/M0.4a are Completed; M0.4 remains In Progress. M0.4b is verified and awaiting commit approval; M0.4c and later tasks are Not Started. Storage transactions are tested; full collaborative transport/restart/capacity gates remain open.
- JavaScript/Python tooling, locks and a real shared protocol/test suite now exist; application services and database durability proof do not. Docker/Redis are not on the current PATH. PostgreSQL 18.7 was built into a private temporary prefix and verified through CODE_ALONG_POSTGRES_BIN; it is not a global PATH/system-service installation. The optional temporary prefix may disappear; provide a trusted PostgreSQL 18 toolset to rerun integration tests. No system/global package installation was made; project caches/dependencies remain ignored.
- Critical open validation: Hocuspocus receipt extension and binary durability; runner origin/header/browser/stdin compatibility. Raise an architecture approval request if these proofs require a design change.
- Existing `AGENTS.md` is intentionally updated in M0.2a to reflect the approved architecture and commit-review workflow; its engineering/security principles are retained.
- Existing design references remain preserved as an ignored local reference library. They are not production assets or vendored dependencies. Any future vendoring/reuse needs deliberate licensing and scope review; never force-add them implicitly.
- Historical machine-local links in the archived architecture may be unavailable elsewhere. The design itself is retained in this repository; evidence reports remain outside it and are not required to read the architecture or plan.
- GitHub `main` was created by the explicitly authorized push on 13 November 2026; local `main` now tracks `origin/main`. Future pushes still require explicit approval.
- TypeScript checks include the actual contract source and test suite; Python type checking is deferred until backend source is introduced. Python has 28 harness/prerequisite tests and JavaScript has 133 regular tests plus 20 explicit database integration cases. The separate 20-case storage suite proves transaction behavior in the private fixture; native integration needs PostgreSQL 18. Full collaborative transport/restart behavior remains unverified. Performance targets, preview budgets and the bounded live-authorization fallback require measurement/acceptance tests before claiming guarantees.

- Temporary dependency maintenance: remove the three scoped minimatch 11.0.1 overrides once ESLint/config-array/typescript-estree adopt a patched version. This tested cross-major substitution is limited to development tooling; rerun lint/type/tool fixtures and audit when removing it.

- Protocol limits and single-in-flight policy need validation with the actual provider/storage adapter in M0.4. Contract code is portable by API/type checks and native Node import; browser runtime compatibility remains unverified. No claim that schema validation proves a full/valid CRDT state or a real database commit.

- Production table mapping/migrations and retention/generation history are not supplied by the checkpoint_proof fixture. The application bootstrap must configure pool acquisition timeouts/idle errors, authenticate writes and enforce process/transport limits. Internal Yjs field usage and hard proof ceilings require revalidation before provider rollout.

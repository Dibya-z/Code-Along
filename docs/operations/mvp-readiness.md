# MVP readiness

Updated 15 November 2026 (Asia/Kolkata). This records tested behavior and open
release gates; it is not a deployment approval or a completed release claim.

## Essential scope

The existing platform includes verified account sessions, workspace/invitation
and private-project management, a multi-file Python editor, isolated browser
execution/output/Stop, collaborative code/cursors, server checkpoints, history,
chat, assignments, participation/team work, immutable submissions, manual
feedback and derived progress/private learning updates. Reuse those modules.
Authoritative server grading, voice, drawing, broad restyling and advanced
analytics are deferred.

## Current verification

- The combined backend pass completed **1,122 tests plus 83 subtests**. A later
  security review changed only backup host/TLS validation and its tests; all
  **46 backup tests plus the real restore exercise** then passed on that final
  patch. Full Ruff/format, strict typing across 208 files, lock and Django checks
  pass. Frontend lint/format/types, **711 JavaScript tests across 64 files**, the
  production web build and byte-identical API-contract generation also pass.
- The final startup repair passes 39 lifecycle/initialization tests, including a
  reproduced repeated-SIGINT interruption during cleanup. Sequential build groups
  and stop requests between groups are included in that verification.
- Frontend source-query cancellation and removal of redundant learning refreshes
  pass 33 focused tests, web typing and scoped lint/format. These regressions
  establish those fixes; exact-source Linux acceptance remains separate.
- Production configuration passes 142 no-database configuration tests; two
  PostgreSQL tests and one real-server test were explicitly excluded from that
  selection. Django's deployment check has no errors and two intentional HSTS
  warnings. See [production preparation](production.md).
- Backup tooling passes 46 lightweight safety tests. Its real migrated-application
  restore exercise passes 1/1 on the first attempt: project identities, exact Yjs
  source/checkpoint receipt, frozen submission/participants, published feedback
  and restored immutability guards survive a restore into a new empty database.
- Actual production Compose parsing and isolated Nginx runtime checks pass. A
  runner-root HTTP500 was reproduced and fixed with `root /tmp`/`try_files`; the
  passing candidate exactly matches the final source. Test TLS, origin injection,
  Worker headers and route denials pass. This is not a live production deployment.
- The proven collaboration admission loop now honors server Retry-After for
  ticket, socket, manual and online recovery, retaining unsaved bytes/session
  identities and permanent-denial behavior. Its focused regressions pass; the
  current browser build includes this fix.
- The affected learning browser gate passes **8/8 in one uninterrupted run**
  across Chromium/WebKit, with no retries, skips or flaky cases. It verifies
  published-starter privacy, final dropped-update recovery/exact submissions,
  consent/withdrawal with retained live source/Worker, and version-pinned A work
  alongside fresh B identities. Test corrections retain the functional byte,
  permission and identity assertions, ordinary quotas and original deadlines.
  A separate unchanged-test core gate also passes **8/8**: two-account editing,
  live cursors/presence, exact-source Run/save/reload, offline merging and
  viewer/revocation/export behavior. These are 16 unique passing cases across
  two frozen-source runs, not the complete remote browser matrix.

## Open gates

| Gate                                                              | Status                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Focused browser acceptance of the latest reliability changes      | Passed: final read-pressure eight cases; prior 16 retained as history    |
| Normal `npm run dev`, live mounts and existing-data preservation  | Passed, including all 19 live preservation checks                        |
| Actual production Compose/Nginx configuration and runtime checks  | Passed isolated proxy/TLS checks; external prerequisites remain          |
| Real migrated project/submission/feedback backup/restore exercise | Passed, including final host/TLS validation recheck                      |
| Combined source checks, reviewed commit and remote CI             | `8c1299a`: source/Compose pass; verified correction awaits full Linux CI |
| Target DNS, real TLS/database/mail checks and deployment          | Operator inputs and separate deployment approval required                |

The owner approved this release bundle and subsequent verified project
commits/pushes without repeated confirmation. The application bundle is
`8c1299a8dc8d41d0d3c596ab945483df71c66d52`; its
[full Linux run](https://github.com/Dibya-z/Code-Along/actions/runs/43644433149)
finished with source/Compose green and 133/134 product cases passed: WebKit 67/67, Chromium 66/67. The remaining Chromium fixture exhausts a rolling read quota after its first cooldown. Pacing alone was insufficient: bounded measurements recorded 211 actor-page API requests in about 70 seconds. Discussion cooldown and learning pre-read coalescing fixes now pass their focused regressions and full frontend checks; the final targeted runtime gate passes eight cases across both engines. All assertions, quotas and deadlines are retained. The corrected bundle passes all eight targeted cases with zero retries/skips/flaky cases. Its WebKit B/A counter records 203 page API requests versus the earlier 211, with no recorded page-level 429 in either new B/A case; these are limited local samples, not load certification. The separate H2 case still honors its actual read cooldown. A new full Linux run is required after this correction is pushed. No deployment or merge has been performed.

Earlier normal builds crossed the unchanged 3.5GiB monitoring floor and stopped
cleanly. The owner-approved cleanup removed 13 exact obsolete cache records;
all ten images, ten containers, three volumes and 132 other cache records were
preserved. Normal startup then passed with sequential image-build groups and
the existing VM configured for 3GiB memory; its previous 4GiB configuration is
backed up. The immutable environment/certificate/reference baseline and all
11 static preservation checks remain unchanged. All 19 live preservation checks
pass, as do explicit-certificate HTTP, read-only module mounts, six socket
boundaries, runner WASM/hash and the existing Compose smoke. No application
test accounts or mail were created.

The final warm build exposed a further spike while exporting five API aliases
after a tooling-configuration edit invalidated the dependency layer. That
attempt stopped cleanly. API, migrations, role provisioning and notification
services now share one project-scoped image; the controller exports it once.
Actual Compose expansion keeps the CI image separate from development, and all
five live service containers use the same image ID. On the final source,
normal startup, both fixes in the built static image and live development
modules, all 19 preservation checks and the existing smoke check pass. The
final run starts at 5.279GiB, records a 4.200GiB minimum and stops normally with the
VM stopped and all eight checked ports closed. Keep adequate free space for
uncached builds; heavy local gates retain the unchanged 3.5GiB monitoring floor.

## Demonstration after acceptance

Start from the repository with `npm run dev`, open `https://127.0.0.1:8443`,
and keep the terminal open. Use `npm run mail -- --latest` privately to retrieve
development verification/reset mail. OS certificate trust remains optional and
was not installed. Detailed setup is in [local development](development-stack.md).

1. Register and verify a teacher and learner in separate browser profiles; sign
   in and create a workspace, then invite and accept the learner.
2. Create a Python project and explicitly give the learner editor access. Open
   it in both profiles, edit together, verify cursors and wait for **Saved**.
3. Run a small Python program, inspect output, exercise input and **Stop**, then
   reload to check server persistence. Browser execution is untrusted practice.
4. As teacher, freeze a named starter revision and publish an assignment.
   Offer participation; the learner accepts and starts **My work**.
5. Edit and run the task, explicitly choose source for submission, inspect the
   immutable receipt, publish manual feedback and verify learner progress.
6. Confirm a teacher without a source grant cannot enter the learner's live
   project, and unrelated users cannot read private submissions or feedback.

This is a manual demo checklist, not evidence that an unexecuted check passed.
Screen-reader/retail-device certification, cold offline installation, classroom
load targets, high availability and trusted automatic grading are not claimed.
Broader metrics/alerts, administrative audit logging and retention policies
remain M5 follow-up work; the delivery outbox is not a general audit log.

# MVP readiness

Updated 15 November 2026 (Asia/Kolkata). The essential MVP and M4 are accepted
on the declared Chromium/WebKit baseline. Production/recovery preparation is
complete; actual deployment and broader M5 pilot gates remain separate.

## Essential scope

The existing platform includes verified account sessions, workspace/invitation
and private-project management, a multi-file Python editor, isolated browser
execution/output/Stop, collaborative code/cursors, server checkpoints, history,
chat, assignments, participation/team work, immutable submissions, manual
feedback and derived progress/private learning updates.
Authoritative server grading, voice, drawing, broad restyling and advanced
analytics are deferred.

## Current verification

- [Full exact-source Linux CI](https://github.com/Dibya-z/Code-Along/actions/runs/43656864362) on `401940f` passes all six jobs: **134 product, 30 isolation, four foundation and six development cases**, plus source/backend/protocol/build checks. Both browsers pass every declared product case with zero configured retries.

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
  establish those fixes; full Linux acceptance is now recorded above.
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
- Earlier local verification: the affected learning browser gate passes **8/8 in one uninterrupted run**
  across Chromium/WebKit, with no retries, skips or flaky cases. It verifies
  published-starter privacy, final dropped-update recovery/exact submissions,
  consent/withdrawal with retained live source/Worker, and version-pinned A work
  alongside fresh B identities. Test corrections retain the functional byte,
  permission and identity assertions, ordinary quotas and original deadlines.
  A separate unchanged-test core gate also passes **8/8**: two-account editing,
  live cursors/presence, exact-source Run/save/reload, offline merging and
  viewer/revocation/export behavior. These are 16 unique passing cases across
  two frozen-source runs, not the complete remote browser matrix.

## Release gates

| Gate                                                              | Status                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Focused browser acceptance of the latest reliability changes      | Passed: latest four cases, prior fourteen fault cases and complete Linux matrix |
| Normal `npm run dev`, live mounts and existing-data preservation  | Passed, including all 19 live preservation checks                               |
| Actual production Compose/Nginx configuration and runtime checks  | Passed isolated proxy/TLS checks; external prerequisites remain                 |
| Real migrated project/submission/feedback backup/restore exercise | Passed, including final host/TLS validation recheck                             |
| Combined source checks, reviewed commit and remote CI             | Passed: `401940f`, all six full Linux jobs successful                           |
| Target DNS, real TLS/database/mail checks and deployment          | Operator inputs and separate deployment approval required                       |

## Earlier investigation and preservation

The owner approved this release bundle and subsequent verified project
commits/pushes without repeated confirmation. The application bundle is
`8c1299a8dc8d41d0d3c596ab945483df71c66d52`; its
[full Linux run](https://github.com/Dibya-z/Code-Along/actions/runs/43644433149)
finished with source/Compose green and 133/134 product cases passed: WebKit 67/67, Chromium 66/67. The remaining Chromium fixture exhausts a rolling read quota after its first cooldown. Pacing alone was insufficient: bounded measurements recorded 211 actor-page API requests in about 70 seconds. Discussion cooldown and learning pre-read coalescing fixes now pass their focused regressions and full frontend checks; the final targeted runtime gate passes eight cases across both engines. All assertions, quotas and deadlines are retained. The corrected bundle passes all eight targeted cases with zero retries/skips/flaky cases. Its WebKit B/A counter records 203 page API requests versus the earlier 211, with no recorded page-level 429 in either new B/A case; these are limited local samples, not load certification. The separate H2 case still honors its actual read cooldown.

The correction is committed/pushed as `35a6f986a5fc54a21e9ea7a55d864f858515d923`; its [full Linux run](https://github.com/Dibya-z/Code-Along/actions/runs/43649781010) finished with all source/Compose/isolation/foundation gates green and **133/134 product cases**: Chromium 67/67, WebKit 66/67. Both A/B cases pass. The sole failure is the lost-work-reply fixture, whose recovery assertion can start before its asynchronous simulated response loss completes. Source inspection establishes that missing test boundary; the remote assertion alone does not prove its timing cause.

Seven related fault-injection cases now pass **14/14 in 131.803s** across both engines as one test-only batch, awaiting the actual committed response and matching browser request completion before their original recovery assertions. There are no retries, skips, flaky cases or global errors. All source/build fingerprints stay frozen; the runtime exits normally and all owned test services stop. Minimum free space is 5.189GiB, with 5.241GiB after cleanup.

The reviewed correction is committed/pushed as `fb422d3246dd10e274e447047a6cd8cb230353bc`; its [full Linux run](https://github.com/Dibya-z/Code-Along/actions/runs/43653629467) finishes with source, Compose, 30 isolation and four foundation cases green, but **132/134 product cases**: 66/67 in each engine. All seven updated fault-delivery scenarios pass in both engines. Chromium fails a redundant direct progress read with 429 after an already verified fresh 200; WebKit records a native API-fetch access-control page error during revoked-access reload, despite subsequent functional permissions/transfer checks passing. The next test correction reuses the actual fresh progress response for all original state assertions.

The five-control local macOS WebKit probe does not reproduce the Linux error: all four caught/settled paths have no unhandled/page error; its deliberate unhandled control is detected. This isolated result does not establish the actual cause. The original strict journey now has bounded passive DOM/navigation diagnostics; no application workaround, navigation change or browser-error filtering is made.

The corrected progress case and original strict permissions journey pass **4/4 in 165.655s** across both engines, with no failures, skips, retries, flaky cases or global errors. App/build hashes remain unchanged; the runtime exits 0, all owned test services stop and all eight checked ports close. Minimum free space is 5.198GiB and final free space 5.240GiB. The earlier WebKit cause remains unresolved; this passing local gate is not a claimed fix or Linux acceptance. Application source, quotas, deadlines and functional assertions remain unchanged. No deployment or merge has been performed.

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

## Current exact-source acceptance

Source `401940fa1d7a75efd789386d5abb7d8df1d54bb4` passes [full Linux run 43656864362](https://github.com/Dibya-z/Code-Along/actions/runs/43656864362). Chromium passes 67 product cases in 16.8 minutes; WebKit passes 67 in 19.8 minutes. Each also passes 15 isolation and two foundation cases; Compose passes six development cases. Source and aggregate jobs succeed. M4 and the essential MVP are Completed.

The earlier WebKit native API-fetch error did not recur in the final strict permissions journey. Its cause remains unresolved, with passive diagnostics retained for M5.1; no application fix or error filtering is claimed. The current complete pass does not certify classroom load, retail devices or absence of intermittent failures.

M5 remains In Progress for broader pilot/load/accessibility/metrics/audit/retention work and target-provider recovery. Real domains/certificates, PostgreSQL TLS/provisioning privileges and SMTP must be supplied and validated before an explicitly approved deployment. No deployment, merge or system certificate-trust change has been performed.

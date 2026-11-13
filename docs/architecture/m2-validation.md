# M2 Python IDE validation

Date: 13 November 2026. Scope: approved M2.1–M2.6. The owner authorized verified granular commits and pushes for M2. The accepted architecture and reference repository are unchanged. M3 has not started; nothing is deployed.

## Delivered behavior

| Unit | Result                                                                                                                                                               | Source evidence                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| M2.1 | Multi-file Python explorer/tabs, stable editing/selection/undo, metadata operations, read-only permissions and responsive panes                                      | `apps/web/src/features/editor/`; `EditorWorkspace` and per-file document/controller models                                      |
| M2.2 | Complete immutable source capture, canonical hashes, generations, entrypoint, runtime/input identity and earlier-source labels                                       | `editor/model/snapshot.ts::captureWorkspaceRun`; `packages/contracts/execution/project-manifest.ts`                             |
| M2.3 | Separate-site runner, exact-origin private channel, pinned Core/NumPy profiles and fresh Python state                                                                | `execution/bridge.ts`; `apps/runner-web/src/engine.ts::ExecutionSupervisor`, `runtime.ts::prepareRuntime`                       |
| M2.4 | Safe sequenced console, batch/interactive input and EOF, captured-source inspection, bounded PNG display/line plots, desktop resize and retained mobile panes        | `execution/console-buffer.ts`, `console-view.tsx`, `panel.tsx`, `plot-gallery.tsx`; `apps/runner-web/src/code_along.py`         |
| M2.5 | Hard Stop, independent deadlines, one terminal result, delayed-packet rejection, output and soft virtual-file budgets                                                | `execution/controller.ts::ExecutionController`; runner `engine.ts`, `output-buffer.ts`, `file-budgets.ts`                       |
| M2.6 | Account-scoped binary recovery, explicit restore/export, shared-device sign-out policy, local drafts, three templates, validated imports and warmed offline practice | `recovery/`; `project-tools/`; runner `asset-cache.ts::RuntimeAssetCache`; product browser recovery/project-tools/offline cases |

Source edits stay in the local workbench and account-scoped recovery. File names, entrypoints, access and other server metadata still use the M1 APIs and authorization. **Local recovery updated is a completed device transaction, not a durable server Saved receipt.** Product collaboration, canonical binary server persistence and chat remain M3.

The source backup is independently authored `.codealong.json` v1, with complete path/source pairs and a reviewed runtime. Imports cannot supply packages, permissions, account identities or server document history. Local copies receive fresh identities and never modify their source project. See [project tools](../protocols/project-tools.md) and [recovery](../protocols/local-recovery.md).

## Execution and recovery boundaries

The editor copies all source synchronously before hashing. Run admits 1–20 Python files, 128 KiB UTF-8 per file and 1 MiB aggregate; it rejects missing files, invalid encoding, traversal, collisions and changed hashes. Exact Unicode, CRLF and missing final newlines are preserved. Later edits cannot change a captured run.

Each run has a fresh supervised Worker, interpreter and filesystem. A trusted iframe/channel may survive success or an ordinary Python error, retaining only verified public runtime bytes. Nonces, run IDs, connection generations, exact message fields and source/runtime identities remain checked. Stop, deadlines, faults, route disposal and periodic renewal destroy the frame path. Worker CSP denies child Workers, application authority and external network destinations; learner source never runs in Django or ordinary job workers.

Core uses Pyodide 314.0.7 / Python 3.14.2; the opt-in scientific profile adds NumPy 2.4.6. Inventories, packages and asset hashes are pinned and self-hosted. Matplotlib was excluded because its compatible Pillow wheel failed the advisory gate; the original standard-library `code_along` helpers provide bounded PNG plots. See the [runtime review](../../packages/runtime-profiles/README.md).

Startup and running each have a 30-second trusted-shell deadline, with an additional 75-second parent deadline. Output has independent 4,096-event/1 MiB limits; display retains 5,000 logical rows and renders 200 at a time. PNG output is limited to four plots, 512 KiB each, 2 MiB total and 1600×1200 pixels, with restricted RGB/RGBA structure and CRC checks. Ordinary temporary-file growth is limited to 8 MiB, 64 new regular files and 128 nodes. Worker-local filesystem hooks are soft practice controls; browser execution has no hard RAM quota or trusted grading authority.

Recovery validates complete binary Yjs state, source hashes, immutable baselines, account/project/document identities and generations. Epoch/revision CAS and serialized writes prevent stale-tab overwrites. It does not reseed recovered documents. Retention is optional; successful sign-out clears account drafts by default and invalidates other tabs. Storage failure leaves editing/export/server sign-out usable. Local records are unencrypted; browser quota and abrupt closure can interrupt a pending write. Wait for **Local recovery updated** and export important work.

Offline practice requires an already open complete project/local draft, a warmed trusted connection and available scripts. The frame retains at most two reviewed public runtime bundles/64 MiB, with byte copies and integrity checks on admission and delivery. Small scripts still rely on the browser cache. Stop, navigation, eviction, a newly selected profile or untrusted HTTPS can require connectivity. Cold offline login/installation is not implemented. No service worker or persisted authenticated-response cache exists, and offline server mutations fail immediately rather than replaying after reconnect. The [execution protocol](../protocols/product-execution.md) records the measured browser/cache limits.

## Local verification

| Gate                                                  | Observed result                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Full Python suite, including real PostgreSQL tests    | **278 passed**                                                                                              |
| Regular JavaScript suite                              | **279 passed**                                                                                              |
| Private PostgreSQL checkpoint storage                 | **20 passed**                                                                                               |
| Private PostgreSQL/real Hocuspocus transport          | **13 passed**                                                                                               |
| Full Chromium/WebKit product regression               | **50 passed**, then **26 affected cases passed** after final runtime-cache refinements                      |
| Session-change recovery regression                    | **Four repeated browser cases passed** after account-read cancellation; existing error assertions preserved |
| Original runner isolation/input/deadline/flood proofs | **26 passed** against the final shared supervisor                                                           |
| Rendered shell/dialog keyboard and focus              | **Four passed**                                                                                             |
| ESLint, Prettier, root/workspace TypeScript           | Passed                                                                                                      |
| Ruff lint/format and strict API mypy                  | Passed; **69** files typed                                                                                  |
| Web, runner, browser-proof and Storybook builds       | Passed                                                                                                      |
| Python lock and offline generated API/client drift    | Passed                                                                                                      |
| Public dependency advisories                          | No known npm advisories; none reported across **59** exact backend/reviewed-browser entries                 |
| Reference preservation                                | All **319** recorded source/design hashes match baseline; approved architecture unchanged                   |

Local native fixtures use macOS arm64, Node 24.22.3, Python 3.13.12 and private PostgreSQL 18.7/Redis 8.4.5. Tests use disposable services and fake accounts, separate from the persistent app database. Product traces remain disabled. Browser suites run sequentially because they share their evidence directory.

The complete product suite covers accounts/workspaces/invitations/permissions plus stable editor state, Linux/native redo chords, frozen multi-file execution, input/EOF, literal markup/ANSI output, scrolling/paging, plots, actual deadlines, file/output limits, recovery conflicts, storage denial/quota failure, incomplete-source rescue, logout retention, template runs, archive round trips and offline Core/NumPy state isolation. The final cache-copy lifecycle and account-cancellation refinements have focused regression coverage in addition to the preceding full run; CI runs the full suite at each delivered revision.

Rendered light/dark desktop and mobile screenshots were inspected during the editor, console, plots, recovery and project-tool units. Checks cover keyboard focus/escape/return, 320–1440 px reflow, 200% text and retained mobile editor/output state. Taste/web-design guidance, `DESIGN.md`, shared tokens and the local Awesome DESIGN.md references informed the original interface. In-app browser tools were unavailable, so the owned Playwright fixtures supplied runtime evidence. These results are not a completed screen-reader, Firefox or retail/mobile-browser certification.

Runtime/browser testing repaired listener-thread TLS handshakes, large responses on closing TLS connections, sign-out navigation with an uncancelled identity read and dialog-unmount focus ordering. The deletion regression preserves its original assertion, adds Escape/continued keyboard checks and passes six repeated cases, all ten project-tool cases and four shared UI cases after repair. The mail helper also now isolates individual messages before recipient matching when Django appends multiple recipients to one spool file. Each correction has a separate commit and regression evidence in the [tracker](../../IMPLEMENTATION_PROGRESS.md).

## Local stack and CI handoff

The normal `npm run dev` rebuilt the API, proxy/runner and connected frontend watcher successfully. PostgreSQL, Redis, API and watcher became healthy; migrations completed. The existing-CA HTTPS check and Compose smoke passed React delivery, readiness, host-only/no-store CSRF behavior, unknown-host and runner API rejection, Worker CSP and the shipped Wasm hash/MIME. A separate verified-HTTPS read confirmed that the actual shell and Worker include the final runtime-cache implementation. Fresh Chromium/WebKit contexts rendered the connected login with no page errors and desktop/mobile reflow; screenshots were inspected. No persistent account was created for these checks.

The primary PostgreSQL system identifier, user/workspace/project/runtime-profile counts and five environment/leaf-key/certificate/CA fingerprints match the pre-test baseline. Normal `npm run stop` then released the controller and dedicated VM while preserving database/mail volumes. The owner can start the app in their own terminal with `npm run dev`. System trust is unchanged.

The normal rebuild, smoke, explicit-CA readiness and preservation checks were repeated after `9b85c9c`; the watcher served the corrected dialog module over verified HTTPS. Normal shutdown completed again. No owned native PostgreSQL/Redis fixtures or checked development/test listeners remain. All 319 reference/design hashes and the approved architecture were checked again unchanged, and all local handoff-document links resolve.

Feature commit `9f86d7c` is pushed. Public [CI run 43434337040](https://github.com/Dibya-z/Code-Along/actions/runs/43434337040) passed Compose, all 26 isolation proofs, four foundation cases and 49/50 product cases, including all six offline scenarios and the repaired sign-out flow. The remaining WebKit case exposed focus restoration racing dialog cleanup after deleting a local draft. Public HTML annotations provided the failure evidence when the unauthenticated API reached its rate limit; restricted logs/credentials were not accessed.

The verified dialog lifecycle repair is committed/pushed as `9b85c9c`. Its full [CI run 43438988881](https://github.com/Dibya-z/Code-Along/actions/runs/43438988881) passed **both foundation and Compose**, including **all 50 product cases**, **26 isolation proofs** and **four foundation cases**. This verifies the focus, sign-out and offline behavior on Linux in addition to the focused local regressions. All M2 implementation/validation gates are complete. The final documentation commit’s own CI is checked separately at delivery; its final hash cannot be embedded in itself.

## Try M2 locally

From the Code-Along repository, with README prerequisites installed:

```sh
npm run dev
```

Open **https://127.0.0.1:8443** and keep that terminal open. Use an existing account or sign up and read its private verification message with `npm run mail -- --latest`. The separate runner uses **https://localhost:8443**. OS certificate trust remains owner-deferred; a site-specific browser exception may be needed for each site, and reliable offline script caching needs browser-accepted HTTPS. Startup does not install a CA.

Open a project, edit `main.py`, and choose **Run code**. Inspect captured source, try input and Stop, or choose **Local drafts** to preview a template. Wait for **Local recovery updated** before reloading. Use a source backup for an independent export/import round trip. To try offline practice, complete an online run first and keep that workbench open; the documented cache/Stop/navigation limits apply.

```sh
npm run status
npm run stop
```

Stopping preserves accounts/projects/mail and releases this workstation's dedicated application VM. The [development guide](../operations/development-stack.md) contains startup, private mail and diagnostic details.

## Remaining gates

M3 must initialize canonical server documents exactly once and **fork legacy `origin: "m2-local"` recovery into a local copy rather than merging independently seeded history into a server room**. Tickets/leases, awareness/cursors, durable checkpoints/receipts, reconnect reconciliation, revisions and chat retain their approved M3 order. M3 requires renewed owner approval.

Future durable replay/submission work should version the bundled `code_along` helper/app release alongside runtime identity; the current source/profile digest does not identify the complete application release. Matplotlib needs a separately reviewed compatible patched package set. Firefox launcher support, full accessibility/manual browser QA, load measurements, backups, production TLS/domain/mail/HSTS and deployment remain their existing later gates. Dependency checks are point-in-time evidence, not a complete security audit.

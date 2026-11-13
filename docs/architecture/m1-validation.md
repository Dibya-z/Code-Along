# M1 product foundation validation

Date: 13 November 2026. Scope: approved M1.1–M1.8 only. The owner authorized verified granular commits and pushes for this milestone without further prompts. No accepted architecture was changed, no reference source was modified and no deployment was performed. M2 has not started.

## Delivered behavior

| Unit | Implemented result                                                                                                                    | Evidence                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| M1.1 | Modular Django backend, UUID/email identity before first migration, validated environment and ASGI bootstrap                          | `apps/api/config/`, `code_along/accounts/`, configuration/startup/migration tests                                                          |
| M1.2 | Persistent development Compose, HTTPS same-origin API proxy, separate-site runner, DB/Redis readiness and disposable native fallback  | `infra/`, `tools/dev/init_development.py`, `run_native.py`, `tools/ci/compose_smoke.py`                                                    |
| M1.3 | Original responsive React routing/providers, CSRF transport, accessible controls and Storybook                                        | `apps/web/src/`, `packages/design-system/`, browser foundation cases                                                                       |
| M1.4 | Signup, private development email verification, sign-in/out, reset, session expiry/invalidation and shared abuse limits               | `accounts/adapter.py`, `forms.py`, `permissions.py`, `tests/test_auth.py`; `features/auth/`                                                |
| M1.5 | Workspaces, bounded scoped lists, active membership, owner transfer, archive/restore and self-leave/removal                           | `workspaces/models.py`, `services.py`, `policies.py`, `api.py`; `features/workspaces/`                                                     |
| M1.6 | Recipient-bound expiring invitation links, digest-only storage, explicit acceptance/revocation and race-safe retries                  | `workspaces/invitations.py`, `invitation_api.py`, `tests/test_invitations.py`; `features/invitations/`                                     |
| M1.7 | Atomic private project/starter-file/document creation, runtime identity, metadata/entrypoint controls, grants and project invitations | `projects/models.py`, `services.py`, `sharing.py`, `validation.py`, migrations/tests; `features/projects/`                                 |
| M1.8 | Offline product/auth OpenAPI, generated typed clients/DTOs, drift checks, CI and real two-user browser flows                          | `common/schemas.py`, `config/tests/test_schema.py`, `tools/dev/generate_api_schema.py`, `packages/api-client/`, `.github/workflows/ci.yml` |

Paths beginning with `code_along/` are relative to `apps/api/`; short backend paths inherit that unit’s domain package. Frontend feature paths are relative to `apps/web/src/`. [Setup](../operations/development-stack.md), [accounts](../operations/authentication.md), [workspaces](../operations/workspaces.md), [invitations](../operations/invitations.md), [projects](../operations/projects.md) and [API contracts](../api/README.md) provide usage details.

## Policy and data integrity checks

Account access requires a verified primary email and active session. Tests cover session rotation/expiry/logout, reset expiry/reuse/other-session invalidation, CSRF/Origin rejection, generic duplicate-signup/reset responses and limits shared across sessions. Account responses are no-store and frontend identity changes clear query state. Production uses host-only Secure/HttpOnly session cookies; no browser JWT is stored. Local messages stay in private mail storage and no external test mail was sent.

Workspace role and private project access are independent. `test_workspace_roles_never_grant_private_project_access`, `test_explicit_grants_control_read_write_and_management` and `test_workspace_owner_cannot_see_or_revoke_private_project_invitations` exercise the separation. UUID/parent attacks, inactive/non-member targets and global staff flags provide no access bypass.

Membership/project/invitation writes acquire the workspace lock first. Real concurrent tests exercise owner transfer, invitation accept/accept-revoke ordering and metadata-version conflicts. Removal requires transfer of every owned project, including archived ones, and clears grants/pending invitations. Consumed links cannot restore removed access. Pending project invitations require pre-existing active workspace membership and remain independent of workspace owner transfer.

Fresh/reverse/reapply/drift migration tests execute against private PostgreSQL 18 clusters. Actual SQL failures verify entrypoint/project, file/document/project/generation, owner/workspace and invitation/project/workspace associations. Atomic seed rollback, path traversal/import collisions, case collisions, UTF-8 source/file-count/project quotas, stable rename, soft deletion and explicit metadata preconditions are tested. Frozen runtime identities derive from the original hash-verified M0 inventory; clients cannot substitute a runtime URL or generation.

The product schema has 21 paths/32 operations; configured browser auth is generated separately. Public DTO projections are checked against actual endpoint responses. Schema generation uses non-connectable DB settings and fails on warnings; two random upstream UUID example locations are normalized without changing validation. Generated declarations are intentionally tracked. Application/client source remains TypeScript 6.0.3; only the codegen CLI uses its required TypeScript 5.9.3 peer.

## Final local evidence

| Gate                                                         | Observed result                                                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Python suite                                            | **203 passed**                                                                                                                               |
| Regular JavaScript suite                                     | **162 passed**                                                                                                                               |
| Private PostgreSQL checkpoint storage                        | **20 passed**                                                                                                                                |
| Private PostgreSQL/real Hocuspocus transport                 | **13 passed**                                                                                                                                |
| Isolated runner, Chromium/WebKit                             | **26 passed**                                                                                                                                |
| Rendered shell/Storybook keyboard and focus, Chromium/WebKit | **4 passed**                                                                                                                                 |
| Account/workspace/invitation/project flows, Chromium/WebKit  | **8 passed**                                                                                                                                 |
| Ruff lint/format; strict API mypy                            | Passed; **64** files typed                                                                                                                   |
| ESLint, Prettier, root/workspace TypeScript                  | Passed                                                                                                                                       |
| Frontend, runner, fixture and Storybook builds               | Passed                                                                                                                                       |
| Locked dependency checks and offline API/TypeScript drift    | Passed                                                                                                                                       |
| npm audit; version-specific PyPI metadata                    | No known advisories reported; **58** exact public PyPI lock entries checked                                                                  |
| Final Linux-arm64 local Compose build/migrations             | Passed; API, PostgreSQL and Redis healthy                                                                                                    |
| Host HTTPS Compose smoke                                     | Passed: React assets, readiness, no-store/host-only CSRF cookie, unknown-host rejection, runner API rejection, Worker CSP and WASM hash/MIME |
| Final Docker UI render                                       | Login/signup render without page errors; desktop/mobile reflow and screenshots inspected                                                     |
| Reference preservation                                       | All **319** recorded PyTogether/design source hashes match the prior investigation baseline; approved architecture HTML unchanged            |

Local native tests use macOS arm64, Python 3.13.12, Node 24.22.3 and private PostgreSQL 18.7/Redis 8.4.5 tools. Browser fixtures use fresh owned contexts, fake `example.test` accounts and disposable services, separate from the persistent Compose database. Product traces are disabled to avoid capturing credentials/mail tokens. Rendered desktop/mobile project and shell screenshots were inspected; reflow checks cover 320–1440px, focus/skip-link behavior and dialog Escape/focus return.

The four product scenarios per browser are in `tests/browser/product/`: registration → verification → login/logout/reset; workspace create/rename/archive/restore; recipient join/removal/old-link rejection; private project sharing with viewer/editor denial, file controls, grant removal and ownership transfer. Native permission tests also send valid CSRF with denied writes, so rejection is not falsely attributed to missing CSRF.

## CI and reproducibility

[Foundation checks](../../.github/workflows/ci.yml) triggers on main pushes, pull requests and manual runs. Actions use immutable commit pins and read-only repository permissions; checkout does not persist Git credentials. It installs exact Node/Python/Corepack/uv and frozen dependencies, regenerates contracts, runs quality/audits/backend/protocol/storage/transport tests, builds all browser targets and exercises Chromium/WebKit runner/UI/product flows.

Native PostgreSQL 18.7 and Redis 8.4.5 are built only under `.runtime/ci-services` on disposable CI runners. The helper refuses non-CI execution. Its downloaded sources are verified with explicit SHA-256 pins; no global database service or reference database is used. Cache paths contain tool/package artifacts, not environment files, TLS keys, mail or test databases. A bounded failure artifact contains only owned browser evidence, with three-day retention; account traces remain off.

A second job builds fresh digest-pinned images, generates private local TLS/credentials, migrates the disposable `code-along-ci` stack and runs the same host HTTPS smoke. Its cleanup targets only that CI project and its disposable volumes. It never deletes local `code-along-dev` data.

The first run [43341104416](https://github.com/Dibya-z/Code-Along/actions/runs/43341104416) at `d1b405d` passed the Compose job and every foundation gate through runner/UI browsers, then exposed a missing local TLS prerequisite before product startup. An isolated fixture reproduced the failure and confirmed HTTPS startup after explicit initialization. The correction is `980130b4eb3746310722f8cdb146e884e094f285`; complete revalidation at [43342883858](https://github.com/Dibya-z/Code-Along/actions/runs/43342883858) finished with **both foundation and Compose jobs successful**, including all eight product browser cases. The final documentation commit’s CI is checked separately at delivery; its own hash cannot be embedded in itself.

To repeat locally, use the documented README commands and trusted native prerequisites. `tools/ci/compose_smoke.py` is intentionally fixed to the owned loopback development origins and self-signed TLS; it is not a production TLS audit.

## Delivery and limits

The development app is available at **https://127.0.0.1:8443**, with runner **https://localhost:8443**. The final images run in the project-owned Lima VM because this host has no working Docker engine/CLI. Only the Code-Along repository is mounted read-only. Existing development DB/mail volumes were retained; an empty failed Multipass fallback and unused owned Docker build cache were removed. No user VM, reference runtime, system trust store or global firewall was changed. See the setup guide for start/stop/mail commands; the browser may require accepting the local self-signed certificate.

Starter file text is read-only in M1. The actual editor, file-content changes, captured multi-file Python runs, console and cancellation UI are M2. Product collaboration, tickets/leases/revocation, binary durable saves/Saved receipts, chat and revisions are M3. Existing M0 proofs are not completion of these product features. Assignments/submissions/feedback and further learning capabilities retain their later milestones.

Firefox remains unverified on this workstation because its owned launcher fails before navigation. Its explicit test commands remain; CI declares Chromium/WebKit only. Screen-reader/retail/mobile certification, load targets, production TLS/domains/SMTP/HSTS, backup/restore, retention, observability and deployment review remain later gates. Browser execution has no hard RAM quota or trusted grade authority; learner source never runs in Django or ordinary job workers. Dependency audits and abuse throttles are not security/capacity guarantees.

Temporary upstream compatibility measures remain scoped: three lint-tool minimatch overrides, one Storybook-docgen glob override and declaration-only Storybook `skipLibCheck`. Remove them after upstream compatibility is verified. Native test tool prefixes and VM caches are machine-local, ignored and may need reprovisioning.

The [commit ledger](../../IMPLEMENTATION_PROGRESS.md) records the independently verified implementation units and one transparent strict-test-typing follow-up; history was not rewritten. Autonomous commit/push authorization ends at M1. Stop before M2 and resume ordinary approval gates.

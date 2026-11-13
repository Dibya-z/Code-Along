# Workspace invitations

A workspace owner can create an invitation for a specific email address as learner or instructor. The opaque link is displayed once. The database stores a SHA-256 digest, scope, issuer, recipient, expiry, revocation and acceptance identity/time; it never stores the raw link. Default expiry is 72 hours, bounded to 1–168 hours. Each invitation grants at most one membership and cannot create an owner.

The recipient needs a verified account with the matching canonical email. Opening the frontend link checks its scope through a CSRF-protected POST, then **Join workspace** accepts it explicitly. Token possession alone cannot admit another account. No public preview exposes a group's identity or recipient details. After signing in, an allowlisted local return path restores the invitation. New users can verify email and reopen the invitation; no pending token is stored in browser localStorage.

- Owner `GET/POST /api/v1/workspaces/{id}/invitations/`: paginated history/create; only create returns the raw link.
- Owner `DELETE .../invitations/{invitation_id}/`: idempotent revocation of an unused link, scoped to the supplied workspace.
- Verified recipient `POST /api/v1/invitations/preview/` and `/accept/`: token in the JSON body, not an API query string. Expired, revoked, archived, wrong-recipient and unavailable scopes receive a generic denial.

Acceptance and revocation lock the workspace before the invitation. Concurrent accepts create one membership. An accepted retry returns the same scope while membership is still active; it cannot reactivate a removed member. Existing active roles are preserved. A fresh valid invitation may reactivate an inactive non-owner membership. Removing a member revokes their outstanding invitations. Ownership transfer revokes pending workspace invitations so new management can issue fresh links. Accepted invitations are historical receipts; revoke actual membership separately.

The React owner panel lists recipient/role/status/expiry, creates/copies one-time-visible links and revokes pending links. Product proxies avoid token-bearing access logs and account responses cannot be cached. Workspace membership alone never grants private code access.

## Project invitations

Project owners can create recipient-bound editor/viewer links at `/api/v1/projects/{id}/invitations/` and revoke unused links at its `/{invitation_id}/` endpoint. These use the same preview/accept endpoints and digest/expiry/retry protections. The recipient must already be an active member of that workspace; a project invitation cannot admit a new workspace member. Acceptance adds explicit project access while preserving an existing grant. Workspace owners/instructors have no private-project invitation management bypass.

Project grant changes/removal and project ownership transfer revoke pending project links. A previously accepted link cannot restore a removed grant. Workspace ownership transfer revokes workspace invitations only; independent private project invitations remain under their project owner. Parent scope is enforced by a deferred project/workspace foreign key. See the [project policy and UI](projects.md).

Verification includes digest-only storage, recipient matching, expiry/revocation, parent scope, role/expiry bounds, archived groups, safe retry, removal/rejoin, concurrent accept and accept/revoke ordering. Two fresh browser sessions also create/join a group, retry the invitation and confirm that removal makes its old link unusable. No external invitation email is sent by the local application; the owner shares its recipient-bound link privately.

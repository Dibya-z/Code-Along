# Workspaces and membership

`code_along.workspaces` owns the workspace boundary. Models/migrations hold UUID identities, creator, name, archive timestamp, ACL version and unique workspace/user membership. Membership has an owner/instructor/learner role and active status. The database permits at most one active owner per workspace; transactional services preserve at least one through all application operations.

All membership mutations lock the workspace first, then re-read authoritative membership inside the transaction. Ownership transfer demotes the previous owner to instructor and promotes an active target atomically. Concurrent transfers by the original owner produce one winner; the other loses authorization after the lock. An owner cannot leave, remove or demote their own membership through ordinary member endpoints. Transfer ownership first. Global staff/superuser flags do not grant product workspace access.

## API and policy

All endpoints require the active verified account/session policy and CSRF on unsafe methods. Reads are scoped before lookup. An unrelated or removed member receives 404; an admitted member attempting owner-only administration receives 403. Invalid metadata returns 400. UUID knowledge is never sufficient authorization. Unknown body fields are rejected.

- `/api/v1/workspaces/`: GET paginated own memberships; POST create a workspace plus its initial owner in one transaction.
- `/api/v1/workspaces/{workspace_id}/`: GET scoped detail; PATCH owner-only name/archive/restore.
- `.../members/`: GET paginated active roster with display names/roles, excluding email addresses.
- `.../members/{user_id}/`: PATCH owner-only instructor/learner role; DELETE owner-only removal or non-owner self-leave.
- `.../ownership/`: POST `new_owner_id`, owner-only atomic transfer to an active member.

Lists use `limit` (1–100, default 50) and `offset` (0–100000). No public directory, arbitrary-user add endpoint or automatic project visibility exists. [Recipient-bound invitations](invitations.md) admit members explicitly. Archived workspaces preserve records and remain readable to members; role/removal/transfer/invitation/project writes pause until restoration. Only the owner can archive or restore. [Private project access](projects.md) is independently checked.

The React feature uses TanStack Query for server state, explicit mutation requests, persistent error notices, paginated lists and accessible confirmation dialogs. Creating/renaming/archive/restore and ownership settings use the real APIs. No mock memberships or invented project activity is displayed.

## Verification

PostgreSQL cases cover atomic creation, invalid names/mass assignment, anonymous/unverified denial, instructor/learner policy, cross-workspace IDs, revocation, owner transfer/last-owner guards, self-leave, archival, uniqueness, real concurrent transfers and bounded/privacy-aware lists. Migration tests migrate all apps from an empty private DB, reverse the custom-account dependency tree and reapply it, checking for drift. Browser tests create, rename, archive and restore through actual sessions. A member owning any project, including archived projects, must transfer that ownership before leaving/removal. Removal clears their grants and outstanding invitations; rejoining does not restore old private-project access.

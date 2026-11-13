# Projects, files and scoped access

Projects belong to one workspace and one active member owner. Workspace roles never grant private live-project access: owners have implicit access, and explicit editor/viewer rows grant everyone else access. The API requires a verified active account and active membership on every request. Project owners manage grants and archives; editors can change the file tree/entrypoint; viewers can only read. Global staff and workspace teaching flags add no bypass.

## Data and transactions

Project creation atomically creates the project, `main.py`, its text document and entrypoint binding. The runtime references a migration-owned profile seeded from the original hash-pinned M0 inventory. Django owns schema changes. A document record does **not** claim that a binary Yjs state or durable save exists; binary initialization/recovery belongs to M3. `initial_source` is immutable starter content, never a REST replacement for live collaborative source.

PostgreSQL deferred composite foreign keys enforce entrypoint/project and document/file/project/generation pairs. A further parent key requires the owner to have a membership in the same workspace. Active membership and owner-only grants are application policy, checked under the workspace lock. One-to-one file/document and unique active case-folded project/path constraints supplement those relationships. No invalid cross-table CHECK is used.

Writes lock workspace first and then the project row (`FOR UPDATE OF self`, avoiding locks on the shared runtime catalog). File/metadata writes require the last `expected_version`; stale edits return 409. Metadata revisions remain JavaScript-safe positive integers. ACL revisions are decimal strings. Rename preserves file/document IDs and generation; deletion is soft and preserves the document. Changing entrypoint validates the same project and an active file; deleting the current entrypoint is rejected.

Paths are relative Python module paths, at most 160 characters, with ASCII identifier components. Traversal, absolute/backslash/special paths, case collisions and module-versus-directory import collisions are rejected. Limits match M0: 20 files, 128 KiB UTF-8 source per file and 1 MiB per project. NUL and unpaired surrogates are rejected. Learner source stays data; Django never evaluates it or writes it to host execution paths.

A workspace member cannot leave/be removed while owning any project, including archived projects. Project transfer promotes an active same-workspace member, removes their redundant grant and leaves the previous owner as an explicit editor. After transfer, removing that member clears all remaining project grants and advances affected ACL versions. Rejoining the workspace does not restore those old grants. Project/workspace archives preserve records and pause source mutations.

## API

- `/api/v1/workspaces/{id}/projects/`: paginated scoped list; POST name/optional curated runtime profile.
- `/api/v1/projects/{id}/`: GET metadata; PATCH name/archive/entrypoint with `expected_version` and role checks.
- `.../files/`: GET bounded file metadata; POST path/optional starter text plus expected version.
- `.../files/{file_id}/`: GET starter source; PATCH rename; DELETE soft-delete, both with expected version. Parent IDs must match.
- `.../grants/`: owner-only paginated explicit access list.
- `.../grants/{user_id}/`: owner-only PUT editor/viewer or DELETE revocation; active same-workspace targets only.
- `.../ownership/`: owner-only POST new owner and expected metadata version.
- `/api/v1/runtime-profiles/`: enabled curated profile identities/hashes; no user-supplied runtime URL or package installation.

The React UI now exposes private project creation/listing, read-only starter previews, file add/rename/entrypoint/removal, owner settings, direct grants, invitations and ownership transfer. Recipient-bound project invitations require pre-existing active workspace membership; project ownership cannot bypass tenant admission. Their parent pair is enforced by a deferred composite FK. Workspace administrators cannot list or revoke another owner’s private project invitations. Grant changes/revocation and project ownership transfer revoke pending links, while a consumed link cannot restore a removed grant. Workspace ownership transfer only revokes workspace invitations, preserving independent private project sharing. An editor, Python run, live room, autosave and Saved indicator are not included in this foundation.

## Verification

The backend tests exercise independent workspace/project roles, UUID/parent-scope attacks, viewer/write and editor/manage denials, grant/revocation, atomic creation rollback, actual composite-FK failures, path/import collisions, all source/file quotas, stable rename, entrypoint/soft-delete, archive/version guards, ownership/removal and real concurrent metadata updates. Migration tests build an empty DB, reverse the account dependency tree and reapply all migrations, including the frozen profile and deferred constraints. All tests use owned disposable PostgreSQL clusters.

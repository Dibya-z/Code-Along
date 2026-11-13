# Named history and source sharing

Named revisions retain a complete immutable source bundle. They are separate from latest-state checkpoint receipts: a receipt confirms a durable current document but is not a historical source retrieval key. The [collaboration protocol](product-collaboration.md) continues to govern live rooms and Saved.

## Capture and integrity

An ordinary project owner/editor posts a name, current `expected_version` and `client_request_id` to `/api/v1/projects/{project}/revisions/`. Django authorizes the real verified session and copies authoritative metadata under the workspace/project locks, then releases those locks before requesting Node's private capture. Node pins every room before asynchronous loading and copies all source values in one synchronous turn. A cold room loads durable binary state, including deletions; it does not reseed an existing document from starter text.

Django validates the complete returned bundle, reacquires workspace then project locks, and rechecks the actual session, current authority, complete file identities/generations/paths, entrypoint, metadata version and reviewed runtime. Only then does it commit the revision and its files together. An access or metadata race fails explicitly. Retry the same request identity after an uncertain response: an identical committed retry returns the original revision, while a changed name/version conflicts. Waiting for Saved before capture helps include the caller's latest edits; capture records the source actually present at the server capture point.

`code-along.revision` version 1 contains project/metadata provenance, the entrypoint, reviewed runtime identity, bundled helper release, and every file's original identity, generation, path, exact source and SHA-256. Files use explicit ASCII path ordering, independent of database collation. Node, Django and the browser independently verify file hashes and the canonical manifest digest. Unicode and CRLF survive; NUL and invalid Unicode fail. Source remains data throughout. The helper identity is `code-along-python-helpers-v1`, with its source digest pinned to the reviewed runner helper.

PostgreSQL guards revision/file immutability and the entrypoint/parent relationships. Each capture retains at most 20 files, 128 KiB per file and 1 MiB complete source; each project currently permits 100 named revisions and 32 MiB of retained revision source. There is no automatic destructive history pruning. These are conservative storage limits, not measured classroom capacity.

## Read and copy

Ordinary currently authorized project participants can list paginated revision metadata and open one complete verified revision. Reading history never connects the frozen viewer to a live room or executes its source. Export retains the source bytes. Copying through `/revisions/{revision}/copies/` creates a new server project and fresh file/document identities in the same workspace. It requires an available unchanged reviewed runtime and an open workspace. It never replaces an existing room. A local copy instead uses source-only independent device-draft identities and the existing [local recovery policy](local-recovery.md).

## Explicit share capabilities

Only the project owner can create, list or revoke `/api/v1/projects/{project}/shares/`. A link has an explicit kind, read/write scope, optional recipient and 1–168 hour expiry. At most 100 unexpired, unrevoked links are active per project. The database stores only the random token's SHA-256. The full token is returned once in `/shares#<token>`, resolved through a POST body, and kept in the route's memory rather than application storage or query-cache keys. Treat the complete URL as a capability; people receiving it can retain source they are allowed to read.

- A **snapshot** link grants read access to one named immutable revision, with anonymous access when no recipient is specified. A recipient-bound snapshot requires that verified active account. It exposes no live room, ordinary project history or chat.
- A **live** link requires a verified active account and current workspace membership. It grants only its selected source scope, without creating a permanent project grant. An ordinary owner opening a read-only link still gets that link's read-only scope. It grants no metadata mutation, invitations, named history, revision capture or chat.

Live workbenches receive verified source baselines from the resolver and obtain fresh per-document tickets with the memory-only capability. Ticket consumption and every lease renewal recheck the grant's expiry/revocation, recipient and current membership. Neither ticket nor lease can outlive the link. Revocation commits matching lease revocation and sends best-effort private invalidation; the existing fail-closed lease deadline remains the fallback. The UI also rechecks on focus/online and periodically, and pauses after failed authority checks while retaining already loaded code for export. Device recovery is not automatically instantiated for capability workbenches; an explicit local copy is an independent source fork.

Expiry or revocation prevents future authorized retrieval/subscriptions. It cannot erase code already read, downloaded, copied or captured by a recipient. Snapshot viewers retain their already loaded bytes and export after a later failed recheck. No share token is an authentication replacement or permission for unrelated APIs.

## Verification boundary

Backend gates cover actual migrated constraints, canonical hashes, capture/permission races, idempotency, source-only copying, recipient/scope/expiry/revocation and capability ticket/lease behavior. Node checks coherent capture, cold binary deletion recovery and bounded invalidation. Chromium/WebKit exercise the actual UI and services, including uncertain capture retry, anonymous snapshots, capability-only users, Saved, read-only local Run and export after revocation. See the [M3 validation record](../architecture/m3-validation.md) for completed runs and remaining gates; this protocol alone does not certify deployment or load.

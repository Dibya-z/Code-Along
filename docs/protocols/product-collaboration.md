# Product collaboration v1

Implementation and verification are in progress under M3. The [checkpoint wire protocol](collaboration-checkpoints.md) remains v1; this document describes the product admission and service boundaries around it. The M0 proof server and `checkpoint_proof` tables remain independent disposable fixtures.

## Authority and transport

Django owns project/file metadata, framework account sessions, permission checks, tickets, leases and all product migrations. Node owns bounded live Yjs documents and writes only binary collaboration state and checkpoint receipts through `code_along_collaboration`. Redis carries transient coordination; it is not source durability.

The browser uses the same-origin `/collab` WebSocket with one Hocuspocus transport per account/project workbench and an independently admitted provider per text document. Room names are immutable `<document UUID>:<generation>`. Tickets travel in provider authentication frames, never URLs or browser storage. Public proxies deny `/internal/`; the separate-site Python runner has no collaboration/API route.

`POST /api/v1/projects/{project_id}/documents/{document_id}/ticket/` requires a verified active session, CSRF, the exact app Origin, active workspace membership and explicit project permission. The strict body contains `generation`, `scope` (`read` or `write`), a per-document `client_session_id` and the Y.Doc's uint32 `awareness_client_id`. The response contains a 30-second, one-use random ticket, UTC expiry and room name. Only its SHA-256 digest is retained in the database.

Node validates the actual upgrade Origin, exact route, resource limits and configured session-cookie name before admission. It forwards only that cookie to the fixed private `/internal/v1/collaboration/consume/` endpoint with a distinct service credential. Django atomically consumes the ticket and rechecks the real issuing session, framework auth hash, verified account, permissions, file association and generation. Browser-supplied actor/session identities cannot grant access.

The private response binds a lease to its connection/transport, user, project, document, generation, allowed scope, client observation identity and awareness ID. Lease secrets are digest-only in Django. It includes the server profile, permission versions and immutable starter source/digest. Node verifies response shape, source bytes and the requested room binding.

Leases last at most 30 seconds and never outlive the framework session. Renewal uses the private `/internal/v1/collaboration/renew/` endpoint and checks current session/auth hash/account/permissions again. Node schedules renewal at approximately ten seconds and uses request-start monotonic time for its deadline. A slow or failed renewal cannot extend the old deadline. Expiry removes read/awareness subscriptions as well as write permission. Queue waits and transaction completion recheck the lease before acknowledging a save.

Permission/file/project/workspace changes and logout revoke matching leases. An authenticated internal invalidation notification provides a fast path; if notification delivery fails, renewal/expiry remains the bounded fallback. This is not a claim of instantaneous revocation during a partition. Changed access requires fresh admission rather than a silent scope upgrade.

## Canonical documents and persistence

Server-backed browser documents start empty and become ready only after canonical provider sync. They must not independently insert starter plaintext. Local-only drafts retain independent documents and never acquire server Saved state.

`collaboration_documentstate` holds one full binary Yjs state per document, its generation, exact-byte SHA-256 and bigint durable revision. First use validates the immutable starter, encodes it once and performs an atomic insert with conflict handling. Concurrent cold starts read the winning row. Every later join loads binary state, including deletion history; it never recreates CRDT history from plaintext.

Automatic stores and explicit checkpoints share the tested per-document queue and SQL compare-and-swap merge path. Updates are captured before asynchronous I/O and validated in throwaway documents. State and receipt commit atomically with synchronous PostgreSQL commit; receipts leave the service only after successful COMMIT. Duplicate checkpoint identities must match both the original submitted-byte digest and observed counter. Revision numbers travel as decimal strings to preserve PostgreSQL bigint precision.

The production adapter uses fixed product table mappings. Metadata reads verify document/file/project/generation bindings and active files. The dedicated database role has narrow metadata-column reads, binary-state insert/select/column updates, and receipt insert/select. It cannot read account/session/chat/history data, modify metadata or own product DDL. Django provisions and verifies the explicitly marked dedicated role after migrations; passwords never appear in migration data or command arguments.

The browser increments its observed counter on local changes, remote changes and deletion-only updates. It retains one immutable pending checkpoint and retries that same identity after uncertain delivery. Only a correlated receipt whose captured counter still covers the current observed document produces **Saved**. Provider Connected/Synced, a successful Run, local recovery, a hash or an old receipt cannot produce that label. A busy room may remain pending conservatively.

Latest-state durability differs from named immutable history. A checkpoint receipt does not retrieve a past source version. A process/host crash can lose edits that were never durably acknowledged; the UI preserves recovery/export and does not promise zero loss of pending work. Backup/restore and deployment storage guarantees remain operational gates.

## Bounds, presence and failure behavior

The service validates binary schemas and strict UTF-8 Python source, rejects NUL/lossy Unicode, and accepts only the `source` text root. Current source and encoded-state bounds remain those in the shared protocol/product limits. It limits frames, awareness payloads, message/byte rates, queued operations/bytes, subscriptions, rooms and connections before unbounded Hocuspocus message queues can grow. The persistence queue also bounds operations and bytes. Development runs the service with an explicit heap/container memory ceiling. These controls are not measured classroom capacity or a substitute for M5 load tests.

Awareness IDs belong to their admitted document subscription. A client cannot update/remove another client's state or claim another identity. Node strips untrusted extension fields and stamps the profile, display name and reviewed cursor color. Relative selections are bounded and resolved only against the current source text. Presence/cursors are transient, carry no authority and do not create a checkpoint on every movement. User aggregation retains separate tab/session lifetimes. Following a participant is explicit, scrolls only the active file, preserves focus/selection and stops with Escape or the visible control.

After admission/load, Node sends a server-only `code-along.presence` v1 `presence.identity` stateless frame. The strict public contract is `@code-along/contracts/collaboration/presence`; its 4 KiB envelope contains document/generation, client-session/awareness IDs and the projected public profile, with no lease, ticket, cookie or source. The browser matches all bindings and its authenticated account before setting its own local awareness profile. This increments its ordinary awareness clock and immediately advertises idle presence. Re-sending the server-stamped awareness at the same clock cannot initialize the sender's own profile: Yjs deliberately ignores that equal-clock echo. Client-forged identity frames are rejected at ingress. Cursor labels use semantic text/surface tokens, while identity hue supplements names rather than carrying identity alone.

Storage failure/backpressure prevents further accepted writes and surfaces a persistent unsaved state with recovery/export. A stale generation, removed file or revoked permission cannot resurrect metadata. Reconnect obtains fresh per-document tickets before reconciling canonical pending updates. UI status distinguishes connectivity, sync readiness and durable save coverage.

Canonical device recovery uses `origin: "m3-canonical"` and is explicitly distinguished from legacy `origin: "m2-local"` recovery. Legacy binary history forks into a fresh source-only local draft; it is never applied to the canonical room. Same-generation canonical recovery still requires fresh authorization and explicit recovery handling. Every prospective merged file is validated in a throwaway document before any live file is changed. An older canonical record is merged as CRDT history and cannot replace newer canonical text by plaintext assignment. See [local recovery](local-recovery.md).

## Internal revision capture

Django's fixed authenticated control request to `/internal/v1/captures/` supplies the bounded complete metadata set, expected version, runtime identity and helper release. It does not hold project/workspace locks across network I/O. Node loads missing binary states, then copies all file source synchronously in one turn. The API rechecks access and the complete metadata binding under its normal locks before committing immutable revision data.

The revision manifest is independently versioned as `code-along.revision` v1. It binds exact paths/source/file/document/generation identities, entrypoint, metadata version, reviewed runtime and `helper_release` (`release_id` and actual bundled Python-helper source SHA-256). Both sides verify file and canonical manifest digests. Changing the helper requires a reviewed release-identity update; an old source/profile digest alone cannot identify changed application helpers.

Named revisions and expiring/revocable snapshot/live sharing have passed their API/browser gates; see [history and sharing](history-and-sharing.md). Versioned product events/outbox and durable chat remain the next M3 unit. Their final contracts, validation and availability are recorded when their implementation gates pass; the private capture surface alone does not complete those features.

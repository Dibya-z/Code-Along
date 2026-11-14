# Collaboration checkpoints — protocol v1

Status: M0.3 contract and local tests. This specification implements the approved architecture's save contract; it is not evidence of a running collaboration server or committed database writes. M0.4 must prove the server/storage obligations below against Hocuspocus and PostgreSQL.

## Purpose and transport

Normal code editing and awareness use the standard Yjs/provider protocols. This small extension carries explicit full-state save requests and database commit receipts. It does not replace document synchronization, authentication, project metadata or chat. Hocuspocus offers string-valued stateless messages; the adapter will route these messages to the admitted document and reply only to the requesting connection, never broadcast a receipt as proof of another client's save. [Provider events](https://tiptap.dev/docs/hocuspocus/provider/events), [server hooks](https://tiptap.dev/docs/hocuspocus/server/hooks).

Each payload is a UTF-8 JSON object with `protocol: "code-along.checkpoint"` and integer `version: 1`. Unknown fields, versions, message directions and invalid values are rejected; no coercion, default values or arbitrary error strings. Authentication tickets stay in the provider authentication exchange, never in this payload or URL. Parsing a document ID does not authorize it: the server must compare document/generation to its authoritative admission context and enforce current write permission/lease.

## Message fields

Every message contains these fields:

| Field                 | Meaning                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `protocol`, `version` | Exact namespace and version above                                                                                 |
| `type`                | `checkpoint.request`, `checkpoint.receipt` or `checkpoint.error`                                                  |
| `document_id`         | Canonical lowercase RFC UUID, supported versions 1–8 with RFC variant                                             |
| `generation`          | Positive JavaScript safe integer; replaced/deleted document generations cannot be silently resurrected            |
| `client_session_id`   | UUID identifying one provider/document observation lifetime; correlation only, not identity/authentication        |
| `checkpoint_id`       | New UUID for each captured request; keep it unchanged during retry                                                |
| `observed_counter`    | Nonnegative safe integer counting every observed Y.Doc update, including remote updates and deletion-only updates |

A request additionally contains `state_base64`: nonempty canonical padded standard base64 of **the complete binary state**, produced by `Y.encodeStateAsUpdate(doc)` without a target state vector. Empty text still has nonempty Yjs state bytes. URL-safe alphabet, whitespace, missing/excess padding and nonzero unused padding bits are rejected. Envelope validation does not prove that bytes are a valid Yjs document or that a client included its entire state: the server must validate/merge against a candidate document with schema/resource checks. [Yjs update API](https://docs.yjs.dev/api/document-updates).

A receipt additionally contains:

| Field              | Meaning                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durable_revision` | Positive canonical decimal string within PostgreSQL signed bigint range, maximum `9223372036854775807`; never a JSON number because revisions can exceed JS integer precision |
| `state_sha256`     | Lowercase 64-character SHA-256 hex digest of the committed **merged binary state**, not necessarily the submitted bytes                                                       |

A correlated error contains only the common fields plus `code`:

- `unauthorized` / `read_only`: stop sending live writes; obtain fresh authorization or follow the permitted recovery/export policy.
- `generation_mismatch`: do not merge old work into a replaced document; surface an explicit recovery flow.
- `checkpoint_conflict`: the same idempotency key was reused with different counter/state bytes; do not retry that mutated request as if it were the original.
- `invalid_state`: well-formed envelope but invalid/unsupported Yjs state; do not report Saved.
- `resource_limit`: stop/reduce live writes according to the server's bounded-buffer policy; preserve recovery/export options.
- `storage_unavailable`: durability is unconfirmed; retain the original pending request and retry with bounded backoff while authorized.

There is no client-supplied user/role, success boolean, SQL error, stack trace or freeform server message. Malformed frames whose correlation is untrusted are rejected by the transport adapter with a generic bounded response/close policy, not reflected into a fake correlated error.

## Resource and encoding limits

The initial shared hard ceiling is **1 MiB decoded binary state per checkpoint**, separate from the architecture's 128 KiB logical source-file budget. Base64 is capped at `4 * ceil(1048576 / 3)` characters; the whole UTF-8 JSON payload is capped at that value plus 4096 bytes for the fixed envelope. Limits apply before JSON parsing and before allocating decoded CRDT state. The transport must also cap raw WebSocket frames before its own string decoding; this package cannot enforce an upstream allocation limit.

These are bounded proof-stage ceilings, not measured room capacity. Enforce logical source, document structure, CRDT growth, pending bytes, message rate, CPU and process memory separately. The parser checks the base64 representation/decoded-size arithmetic without decoding or loading Yjs. The server proof must apply the bytes safely and reject invalid state without broadcasting acceptance.

## Capture, persistence and matching

1. Give each observation lifetime its own `client_session_id`. Increment `observed_counter` on every Y.Doc update, including remote/deletion events. Never reset it within that session. Rotate the session before counter exhaustion or after rebuilding the controller/document. Capture counter and complete state synchronously before asynchronous work; keep the pending request immutable.
2. A parseable request enters the authenticated per-document persistence queue shared with autosaves. Recheck permission, scope/generation, schema and resource policy. An initial sync or provider `synced` event is not a commit.
3. The room coordinator merges the request, freezes binary bytes and uses expected-revision compare-and-swap with reload/merge/retry to prevent stale overwrite. It atomically commits DocumentState, incremented revision and the request's receipt record. No receipt is sent before that transaction succeeds under the documented database durability policy.
4. The receipt echoes all common correlation fields. Only a receipt from the trusted admitted provider whose document, generation, session, checkpoint ID and captured counter match the pending request can acknowledge it. The client may display Saved only if its **current** document, generation, session and observed counter still match too. A later local edit, remote edit or deletion invalidates that Saved candidate, even if the state vector did not change.
5. Errors, disconnections, malformed/oversized messages and missing receipts never imply Saved. A server write might have committed before a lost response: retry the immutable request rather than infer success or failure. Unknown versions fail closed; upgrades require coordinated adapter/client support.

`receiptCoversObservedState` checks correlation and current-state coverage of already parsed receipts; it neither authenticates a server nor proves a database commit. The transport and persistence implementation must establish those obligations. A digest is not a trusted identity, signature, named revision or proof that a user's local run used the committed merged source.

## Idempotency, retention and ordering

The idempotency key is `(document_id, generation, client_session_id, checkpoint_id)`. Store the captured counter and server-computed hash of the submitted binary bytes with the receipt. Within retention, an identical retry returns the existing receipt without reapplying/incrementing merely for the retry; a different counter or different bytes is `checkpoint_conflict`. Do not trust a caller-supplied hash. A reused key cannot authorize a revoked user.

After receipt retention expires, treat the retry as an unacknowledged full-state request: validate/merge it and issue a fresh committed receipt. Never infer Saved or lost work from a missing receipt. Preserve provenance needed by retained submissions when pruning records. Old receipt metadata cannot reconstruct old document bytes: named revisions must separately freeze/copy payloads.

The M3 product policy targets 2048 recent receipts/document, expires unreferenced receipts after 24 hours and enforces a database insertion capacity of 4096. Bounded Django maintenance preserves canonical binary and referenced provenance; the Node role cannot prune. Capacity errors stop accepted writes with recovery/export, while an existing duplicate can still return its original receipt. See [product retention](product-collaboration.md#bounded-receipt-retention). M0 proof tables remain independent fixtures.

The client permits one immutable in-flight checkpoint per document session. Later edits increase the counter and stay pending for the next checkpoint; do not mutate the in-flight payload. This bounds client bookkeeping and avoids reordered receipts falsely advancing save status. Coalesce changes and bound queues/retries; outages have no finite durability-delay guarantee. A validated receipt may cover older work while current work remains Saving.

## Compatibility and verification scope

The package uses browser/Node standard primitives and no Node-only imports at runtime. Validators are hand-written for this small fixed envelope, with typed results and generic non-sensitive error codes; no runtime validation dependency is needed. The client and server response parsers are separate to reject wrong-direction messages.

M0.3 tests must exercise actual Yjs deletion-only and remote-update observation, receipt correlation/stale-session handling, strict message validation, integer/base64/digest limits, malformed UTF-8-size cases and error handling. Yjs is a **test-only dependency** here. Tests do not create server receipts or simulate PostgreSQL success and then claim durability. M0.4 separately needs real transport, initialization/idempotency, atomic commit, stale autosave, duplicate, crash/restart and database-failure evidence before this extension can serve users. Its transport tests must also prove a client-crafted receipt/error cannot be echoed or broadcast as a trusted server reply to another client.

# Private learning updates

Private learning updates are implemented and locally verified across database, Redis/Channels, HTTPS and browser checks. Exact acceptance evidence and whole-milestone status belong in [M4 validation](../architecture/m4-validation.md) and [the implementation tracker](../../IMPLEMENTATION_PROGRESS.md).

## Purpose and authority

Learning updates carry assignment-scoped invalidations. Clients read the authorized HTTP views again; messages contain no source code, draft feedback, assessment text, recipient list, stream identifier or session identifier. They grant no project, submission or teaching access.

The exact same-origin socket is `/events/learning`, with an empty query and the configured application Origin. `/events` retains the separate project/chat protocol. The separate runner origin cannot use either API socket.

An actual current framework session, active account, primary verified email and active workspace membership are required. The `teaching` audience additionally requires a current owner/instructor role. The `participant` audience selects only the actual account's lifetime participation. Ended participation retains historical read access; it does not renew learning consent. Archived parents permit authorized historical reads. Project ownership, source grants and share links confer no learning-stream authority.

Authorization pins the principal and immutable stream identity, joins the private audience/session groups, then reads a fresh authorized head before acknowledgement. Each forwarded change and heartbeat checks current authority again. Database checks have a two-second bound and a conservative thirty-second authority deadline; a late result cannot extend expired authority. A ten-second authorized head repairs a final dropped broker marker. Existing durable session invalidation handles logout.

## Wire format

Commands are UTF-8 JSON of at most 1 KiB. Unknown/duplicate keys, binary frames, repeated subscription, malformed UUIDs and invalid types are rejected. UUIDs use canonical lowercase spelling. Generations are canonical ASCII decimal strings in `0..9223372036854775807`, avoiding JavaScript integer truncation.

```json
{
  "protocol": "code-along.learning-events",
  "version": 1,
  "type": "subscribe",
  "scope": "assignment",
  "assignment_id": "80af51de-27fc-4d9e-9b42-a258a91ae260",
  "audience": "participant",
  "after_generation": null
}
```

Server frames are at most 4 KiB. Every frame contains `protocol`, `version`, `scope`, `assignment_id`, `audience`, `type` and `head_generation`. Exact additional fields are:

| Type               | Additional fields           | Meaning                                                           |
| ------------------ | --------------------------- | ----------------------------------------------------------------- |
| `subscribed`       | `refresh_required`: boolean | Fresh authorized head; compare with the supplied anchor.          |
| `learning.changed` | None                        | A committed positive generation may require visible HTTP refresh. |
| `head`             | None                        | Periodic fresh authorized head, including zero.                   |

This is a coalesced head protocol, not an event-history/replay API. Intermediate generations may be skipped and markers may be duplicated. Close codes are `4400` for invalid messages, `4403` for denied authority and `4401` for unavailable authorization/transport processing. Reconnection never authorizes a mutation.

`GET /api/v1/assignments/{assignment_id}/learning-head/?audience=participant|teaching` is the HTTP counterpart. Its no-store response contains the common envelope and `head_generation`, with **no `type` field**. It uses the same session/audience policy and never creates a stream on read. A member without a lifetime participation uses ordinary authorized visible-view refresh until offered participation; repeated unauthorized participant subscriptions are unnecessary.

## Durability and delivery

`learning.models.LearningNotificationStream` retains one teaching row per assignment and one recipient row per lifetime participation. Existing assignment/participation caps bound this at 10,100 rows per workspace. Its immutable scoped identity is enforced in PostgreSQL. The migration backfills zero-head rows in ordered batches without fabricating past changes.

Authoritative domain changes and their head increments commit atomically. Explicit collectors deduplicate affected old/new team recipients before locking streams in stable order. Publication, participation/roster/consent, work, new submissions, published feedback and relevant workspace availability/authority changes invalidate the appropriate views. Private draft edits and confirmation of an already committed original nonce do not increment heads. Reads/subscriptions allocate nothing.

The existing dispatcher, worker and scheduler are reused. A dispatch batch claims **eight total rows** across project events, private invalidations and learning heads. Claim transactions finish before network delivery. Learning claims capture a stable generation `g` for thirty seconds; retries/crash recovery retain `g` even when a newer domain head `h` arrives. Only the live unexpired token/generation can acknowledge `g`. Acknowledgement leaves newer `h` pending. Retry delays cap at sixty seconds. Broker publication means neither browser receipt nor completed HTTP refresh.

Implementation evidence: [notification access](../../apps/api/code_along/learning/notification_access.py), [domain collection](../../apps/api/code_along/learning/notifications.py), [delivery](../../apps/api/code_along/learning/delivery.py), [consumer](../../apps/api/code_along/learning/event_consumer.py), [strict wire](../../apps/api/code_along/learning/event_wire.py) and [shared dispatcher](../../apps/api/code_along/events/dispatcher.py).

## Client integration

The client refreshes only registered visible learning views, retains source/editor/chosen submission/draft/original-command lifetimes, and never automatically replays writes. Its anchor advances only after successful head-before, visible-view reads and head-after synchronization. Reconnect/focus/heartbeat repair missed markers; bounded periodic refresh also handles deadline/offer expiry when no committed head changes. Failed reads, offline transitions and `429 Retry-After` use bounded recovery rather than a tight loop.

Each serialized refresh checks the actual account before reading. An exact-key silent cancellation starts its fresh replacement before awaiting cancellation, so overlapping manual callers await the fresh outcome instead of confirming a cached snapshot. Abort, authority loss or a failed visible read cannot mark stale views current. Private assignment/feedback drafts and Source queries are not registered for learning refresh.

# Manual instructor feedback

M4.5 is locally verified. It extends [exact submissions](submissions.md) with private saved drafts and explicit immutable publications. There is no automatic grade, remote learner-code execution or editable progress endpoint. Exact-source Linux acceptance is tracked separately in the validation record.

## Authority and source

Review uses the submission's frozen source and assignment version. A current verified workspace owner/instructor needs no grant to the live project. Live H2 cannot replace submitted H, and publishing assignment version B does not relabel A's review. Source owners, editors, viewers, mentors and shares gain no feedback authority through those roles alone.

A teacher who is a frozen participant cannot read, save or publish a draft on that submission. The server rejects this before querying/creating its draft or searching publication nonces. Another authorized teacher must review it. That teacher's own learner-facing published-feedback read remains available under the ordinary frozen-participant policy.

Published feedback is readable by current scoped teachers and frozen participants with current verified active workspace membership. Participation withdrawal, team departure and source-grant loss do not erase frozen-history access. Workspace removal denies it. Current identity, teacher role and actual framework session/hash are rechecked around commands and sensitive serialization. Feedback operations fetch no live Source/Work/code room.

## Draft, save and publication

`InstructorFeedback` holds one mutable draft per submission. An absent draft GET returns revision 0, empty comments and null status/editor/time without creating a row. Saving uses exact revision compare-and-swap: expected revision 0 creates revision 1; each later save increments the revision. Competing teachers cannot silently overwrite another saved revision.

Comments are exact plaintext, limited to 8192 UTF-8 bytes with no NUL or isolated surrogates. BOM, line endings and accepted Unicode remain unchanged. Blank detection uses the existing fixed cross-language blank-codepoint set. A null draft assessment permits incomplete/empty saved work. `reviewed` and `needs_changes` require nonblank comments even on Save; `complete` may have empty comments. Publication requires a saved nonnull assessment.

**Save feedback draft** does not publish. It changes no learner-visible timestamp, public parent record, project event or publication. The draft's last editor/time remain distinct from publication provenance; another authorized teacher can explicitly publish the saved revision they reviewed.

**Publish feedback** creates an immutable `FeedbackPublication` with a server number, frozen publisher label, UTC time, exact comments/status and digest. It advances the draft revision/current-publication pointer atomically. Correcting feedback creates publication N+1; previous publications remain readable and unchanged. Statuses are manual decisions: `reviewed`, `needs_changes`, or `complete`. Every public record identifies `assessment_kind:'manual'`.

## Private HTTP contract

All routes are below `/api/v1/assignments/{assignment_id}/submissions/{submission_id}/`, require the existing verified-session/CSRF policy and return no-store responses:

| Method | Suffix                                  | Result                                                            |
| ------ | --------------------------------------- | ----------------------------------------------------------------- |
| GET    | `feedback/`                             | `{latest:FeedbackPublication                                      | null}` |
| GET    | `feedback/draft/`                       | Teacher-only saved draft or revision 0                            |
| PATCH  | `feedback/draft/`                       | Full replacement `{expected_revision,comments,assessment_status}` |
| GET    | `feedback/publications/?offset=&limit=` | Bounded published history `{items,count}`                         |
| POST   | `feedback/publications/`                | `{expected_revision,client_request_id}` → 201 new / 200 original  |

Unknown fields, unsafe revisions, malformed UTF-8/JSON, duplicate keys and nonfinite numbers are rejected. The actual command stream is bounded at 64 KiB before JSON allocation; ordinary proxy/global limits are unchanged.

Published DTOs contain submission/assignment/version IDs, number, comments/status, publisher, published_at, content_sha256 and manual kind. They expose no private draft revision, editor, status, existence hint or request nonce. A learner never receives a draft DTO through a publication read. `can_review` remains false on one's own frozen-participant submission.

## Transaction, retries and retained budgets

`feedback_services.lock_review()` follows workspace → assignment → submission → feedback lock order. New writes require open parents. `save_draft()` and `publish_feedback()` enforce final current-session/teacher/nonparticipant authority before commit. No network capture or learner execution occurs in the transaction.

Publication nonce identity is feedback + publisher + client_request_id, binding the expected saved revision. An authorized identical committed retry returns its original publication before new-write parent/CAS/capacity checks, even after later edits/publications or archive. A changed revision with that nonce conflicts. Current teacher/nonparticipant authority is always required; a nonce is not a capability. The client must retain the original pending body/nonce after an uncertain reply and retry explicitly, without automatically publishing a newer draft.

Retained limits are 20 publications and 128 KiB publication metadata per submission, 16 KiB per publication, 8 MiB per assignment and 32 MiB per workspace. Private counters reserve bytes atomically with publication/pointer/revision changes; rollback restores all of them. Existing submission source/attempt budgets remain separate. Permanent capacity conflicts are 409 without Retry-After; ordinary 429 remains transient. Archive does not release immutable retained budgets.

The content digest is SHA256 of compact UTF-8 JSON:

```text
["code-along.manual-feedback",1,submission_id,assignment_version_id,number,assessment_status,comments]
```

Database constraints bind publication, draft and submission parents/current pointers. Immutable triggers protect published facts and guarded draft identities. The next migration refuses reversal before removing retained private authority; committed submission/source migrations remain unchanged. The restricted collaboration role has no access to feedback tables.

## Client and acceptance boundaries

The review UI composes on the static submission route. It keeps editable local text separate from the saved CAS snapshot and any pending immutable publication. Fresh account checks, abort/current-account guards and strict IDs/status/hash validation reject stale or malformed completions. Local errors/conflicts preserve the draft for explicit reconciliation. Feedback is not stored in source files, project chat, browser recovery or an offline mutation queue.

Comments render as text, including HTML-like input. Published history and manual author/time remain distinct from unsaved/private drafts and untrusted browser practice. M4.6 adds derived progress and private refresh notifications later; M4.5 does not claim those updates. Actual database/browser results and remaining limitations are recorded in the [M4 validation report](../architecture/m4-validation.md).

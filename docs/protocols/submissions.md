# Exact private submissions

M4.4 is locally verified. See the [M4 validation record](../architecture/m4-validation.md) for passing gates and the separate Linux/milestone acceptance status.

A submission stores the learner's chosen immutable source, not a new capture of the collaboration room. A retained run of H remains selectable after peers have edited the room to H2. Current code can also be submitted without running Python or waiting for Saved. Neither browser execution nor a collaboration checkpoint is authoritative assessment evidence.

The implementation is in `apps/api/code_along/submissions`. It depends on the artifact-scope foundation in `projects/0010_revision_artifact_scope` and `learning/0005_starter_artifact_scope`. It never runs learner Python, calls Node to capture source, or inserts a public project event.

## Request and receipt

```text
POST /api/v1/assignments/{assignment_id}/works/{work_id}/submissions/
Content-Type: application/json
{
  client_request_id: canonical UUID,
  manifest: complete ProjectRunManifest v2,
  practice: null | RunEvidence | ChecksEvidence
}
```

All three fields are required; unknown fields are rejected. The manifest must describe a project, contain 1–20 files, and pass exact v2 source/runtime/path/identity/hash validation. Integral JSON numbers are normalized to integers before canonical hashing; booleans, nonintegral numbers and nonfinite values are rejected. Generation must fit the database's positive int32 domain. The original valid UTF-8 bytes are preserved, including leading BOM, CRLF/LF, combining characters and accepted control characters. NUL and isolated surrogates are rejected. Per-file and aggregate decoded limits are 128 KiB and 1 MiB.

`manifest.py` returns owned frozen records. Source-v2 and artifact-v1 hashing happen before domain locks. The artifact-v1 hash delegates to the existing reviewed revision codec; it is distinct from the run-v2 hash, which also binds source kind and stdin mode. Neither digest is renamed as the other.

The source strings are stored once in immutable `RevisionFile` rows under a `ProjectRevision` with `artifact_scope=submission` and `provenance=client_submitted_snapshot`. Submission retains v2-only scalar context and its source hash. Detail reconstructs and verifies the original v2 manifest from those files; no duplicate source JSON blob is retained.

Creation returns 201. An authorized identical committed retry returns 200 and the same detail shape:

```text
SubmissionSummary:
  id, assignment_id, work_id, assignment_version_id,
  assignment_submission_number, submitted_at,
  author:{id,display_name}, participants:[{id,display_name}],
  client_request_id, source_manifest_sha256, artifact_manifest_sha256,
  artifact_scope:'submission', provenance:'client_submitted_snapshot',
  practice, can_review

SubmissionDetail adds:
  manifest, helper_release,
  published_version:{number,title,content_sha256,submission_mode}
```

Receipt correlation includes the original actor, nonce, Work, version, scope and both hashes. Equal source hashes alone do not identify the same attempt. `can_review` requires a current scoped teacher, open review parents, and absence from the frozen participant set. Feedback endpoints belong to a later unit; this field does not expose a draft or grade.

## Practice evidence remains an untrusted claim

Run evidence has exactly `kind:'run'`, `run_id`, `source_manifest_sha256` and `status`. Visible-check evidence has those keys with `kind:'visible_checks'`, plus `practice_manifest_sha256`, `published_checks_sha256`, `checks_sha256` and `check_origin:'published'|'local_practice'`.

Both use the actual terminal statuses `succeeded`, `failed`, `cancelled`, `timed_out` and `output_limit`. Every status, including succeeded, is client-reported and untrusted. Null is valid for a current capture or a run without a correlated terminal. There is no output, stdin text, plot, check-copy source, checkpoint receipt, grade or caller-supplied participant list in this upload.

The server binds evidence to the chosen source hash and, for checks, recomputes its aggregate against the pinned assignment/version/content/helper context and effective checks digest. Published origin must use the published checks digest. Accepted evidence is copied into a fixed field order before request hashing, so JSON object key order cannot create a false nonce conflict.

## Admission, freezing and atomicity

Commit lock order is workspace → assignment → bounded teams/participations/Work → source project → runtime profile. Normal workspace-first mutations serialize consent, ownership, source grants and metadata changes. No learner execution or network I/O occurs under these locks.

A new submission requires:

- An actual current verified account/session/hash and active workspace membership.
- An active Work and open assignment, workspace and source project.
- Current accepted eligible participation, exact team consent/approval where applicable, and the source owner within that eligible subject.
- Ordinary project read access. An eligible team participant reduced to viewer may submit; a source viewer, owner, mentor or teacher without eligible participation cannot acquire submission authority through that role alone.
- The chosen snapshot's project, metadata revision, file/document identities, generations, paths and entrypoint matching current structure. Ordinary Y.Text edits alone do not invalidate H.
- A known reviewed runtime identity and helper matching pinned Work.version and current metadata. Disabling execution of an otherwise valid known profile does not prohibit storing source; new Work and Run retain their separate execution policies.
- The pinned version's deadline, attempt policy and retained capacity limits.

Work A remains pinned to version A after B is published. Submission does not require A to equal the assignment's latest version. Server UTC under the final locks governs `due_at`, with equality allowed and later requests rejected. Practice and continuation are separate from this new-submission deadline.

Participants come only from the actual current eligible subject. Immutable WorkMember rows record historical source-sharing intent and are never substituted as graded participants. Submission's internal `participant_count` is derived from that subject, constrained to 1–6 and included in metadata accounting. A parent-locking insert guard rejects additions once that count is reached. Deferred checks on parent and participant insertion require an exact complete set at commit. Updates and deletes are forbidden, so a later valid workspace participant cannot be appended to gain private-source access.

Revision/files, Submission, frozen participants, attempt consumption and private usage counters commit in one transaction. Every frozen peer's current active/verified eligibility and the actual actor session are rechecked after writes. Failure rolls back the whole operation. There is no public `revision.created`, outbox row, public parent timestamp update or project history/count mutation for a private write.

## Idempotency and finite retained budgets

Nonce identity is `(assignment, actor, client_request_id)`. Its normalized request digest binds Work, complete chosen manifest and nullable evidence. Source strings remain exact; JSON object field ordering is not semantic request data. Reusing a nonce with changed Work/body/evidence returns `submission_nonce_conflict`.

The original committed request is checked before new-submit eligibility, deadline and capacity consumption, after current identity and private-read authority. A frozen participant with a current verified active workspace membership can confirm it after withdrawal, source-grant loss, archive or deadline. Workspace removal denies read/retry; rejoining restores that user's frozen-history read without reviving participation or consent. Knowledge of a nonce alone grants no authority.

Per-person attempts are immutable and unique by `(version,user,attempt_number)`, bounded by the version's 1–100 max_attempts across fresh Work, projects and team rosters. Team sequence is monotonic by `(version,team)` across roster replacements; its internal bound is 256, so a valid replacement roster can produce team sequence 101 while its new participants each consume attempt 1. The assignment-wide submission number gives deterministic order under the assignment lock.

Retained limits are 256 submissions / 32 MiB source / 4 MiB metadata per assignment and 1,024 / 128 MiB / 16 MiB per workspace. Each submission has a 16 KiB metadata limit. The fixed metadata charge includes frozen identifiers, participants, evidence, hashes, times, runtime/helper and file metadata, excluding raw source strings charged separately. Private usage rows hold these counters without changing public parent `updated_at`. Archive does not prune or release a retained budget.

Permanent capacity conflicts are 409 without Retry-After; ordinary throttling remains 429. Candidate-agnostic availability cannot promise an arbitrary upload fits remaining bytes. At exact raw-byte capacity an empty-source candidate is still possible; candidate-specific projected usage is checked at commit. Availability never gates confirmation of an existing nonce and exposes no other participant's attempt totals.

## Private reads

The Task's **Submit code** disclosure offers **Choose current code** and **Choose code from this run**. `SubmissionModel` retains one copied immutable candidate/body/nonce in memory across live edits, later runs, check changes and unavailable Source/Work responses. Capture starts in the click before hashing/authentication. Only matched runner terminals attach untrusted evidence; current captures attach null. **Retry same submission** checks the actual account and resends the original request without recapturing or automatically replaying it after reconnect. Choosing different code is explicit and warns that the original may have committed. Leaving/reloading the account-scoped workbench clears this in-memory choice; it is not saved to device recovery.

The static browser route `/assignments/:assignmentId/submissions/:submissionId` checks the actual account and waits for a fresh authorized read rather than treating cached bytes as entry authority. The verified viewer exposes files/export, client-submitted provenance, pinned environment and a collapsed receipt. It mounts no Work/live-project lookup, Yjs provider, project events/chat socket or execution Worker. [Manual feedback](manual-feedback.md) and one scoped [private learning observer](learning-updates.md) are implemented and locally verified; this grants no live-source authority. Exact acceptance evidence and milestone status are in the [M4 validation record](../architecture/m4-validation.md).

```text
GET /api/v1/assignments/{a}/works/{w}/submissions/?offset=...&limit=...
{items:SubmissionSummary[],count,
 availability:{can_submit,reason,checked_at}}

GET /api/v1/assignments/{a}/submissions/?assignment_version_id={v}&offset=...&limit=...
{items:SubmissionSummary[],count}

GET /api/v1/assignments/{a}/submissions/{s}/
SubmissionDetail
```

Work history filters rows and count by frozen-participant/current-teacher authority; a currently eligible subject may read an empty history. Assignment discovery requires a current scoped teacher and optionally filters version. Pagination defaults to 50 and permits at most 100 rows.

A fresh static detail read independently authorizes a frozen participant or current scoped teacher. It needs no live source project, project grant, file metadata, room, ticket or project-socket query. Source IDs inside its frozen manifest remain opaque provenance. Detail and teacher-wide lists recheck their current audience after serialization; teacher demotion cannot retain an earlier broad read permission. Removal from the workspace denies private reads. Source shares, unrelated teachers, source ownership and staff status confer no bypass.

Public project revision/share/starter/copy APIs remain project-scope only. Scope-qualified foreign keys bind Submission to its private revision and complete Work parent tuple; frozen participant composite keys bind the actual assignment/version/user participation. The collaboration SQL role has no access to submission, participant, counter or revision-source tables.

## Bounded HTTP transport and conflicts

The authenticated JSON endpoint reads at most `6*1024*1024 + 64*1024 + 1` actual bytes before JSON allocation; one overflow byte yields 413. This transport allowance accommodates escaped 1 MiB decoded source. It does not trust a missing or false Content-Length. JSON parsing rejects duplicate fields, nonfinite numbers, malformed UTF-8 and nesting deeper than 32 while ignoring braces/brackets/escapes inside strings. Source serializers never trim text.

Only the exact submission collection POST receives the 6 MiB + 64 KiB proxy allowance. Ordinary APIs keep 2 MiB, Django's global limit stays 512 KiB, and runner/internal routing remains denied. Native proxy chooses the limit by exact method and canonical UUID path. Nginx uses a POST-only server rewrite into an internal location before body-limit location selection, then strips the internal prefix with break before forwarding the unchanged API path/query/method. This follows the documented [server/location rewrite order](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html) and [changed-URI proxy behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass); a named-location fallback would not recheck the original body limit.

Malformed request/manifest/evidence uses bounded 400 codes; unsupported media/charset may use 415. Structural/runtime mismatch uses `submission_structure_changed` / `submission_runtime_changed`. New-write conflicts distinguish unavailable Work, participation, exact roster, source access, deadline, attempts, and assignment/workspace count/metadata/raw-byte capacity. Unauthorized private reads remain generic 403/404. Network/429/503 uncertainty must preserve the original body and nonce for an explicit fresh-auth retry rather than automatically consuming another attempt.

## Migration preservation

The new initial migration depends on both scoped-artifact foundation leaves. Each submission leaf refuses reversal before any DDL if a Submission or any private/non-project revision remains, preserving private authority and immutable storage. The original projects and learning scope guards remain independently effective. Reversal tests exercise every actual guard, check no ALTER/DROP before refusal, and preserve frozen bytes and immutable triggers without disabling protections or retagging data.

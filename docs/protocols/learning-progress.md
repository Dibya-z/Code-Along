# Learning progress

Derived progress is implemented and locally verified across database, privacy, migration and browser checks. Exact acceptance evidence and whole-milestone status belong in [M4 validation](../architecture/m4-validation.md) and [the tracker](../../IMPLEMENTATION_PROGRESS.md).

## Derived history

Progress is a read model, not a mutable grade record. The server selects the latest immutable submission for the actual learner and **exact requested published assignment version**, ordered by assignment submission number. It then selects the latest manual feedback publication **on that submission**. A newer submission without feedback returns `submitted`; correcting an older submission cannot replace the newer submission's state. Publishing version B never changes progress requested for A.

| State           | Authoritative evidence                                            |
| --------------- | ----------------------------------------------------------------- |
| `not_started`   | No matching submission or historical work membership.             |
| `in_progress`   | Matching retained work membership, without a matching submission. |
| `submitted`     | Latest matching submission has no published manual assessment.    |
| `reviewed`      | Its latest manual publication says reviewed.                      |
| `needs_changes` | Its latest manual publication requests changes.                   |
| `complete`      | Its latest manual publication explicitly marks complete.          |

Retained work membership supplies only a historical started marker. Frozen submission participants define whose submitted work and assessment count. Neither practice output nor client-supplied state can set an assessment, score or completion. Unpublished feedback drafts are excluded.

History uses scalar submission/publication metadata, without loading live project source or source grants. Lost Source access, ended learning consent, deadlines and archive state do not rewrite submitted history. Current account/session and workspace membership are still required to read it.

## Read-only endpoints

Both endpoints require `assignment_version_id`, which must identify a published version of the scoped assignment:

- `GET /api/v1/assignments/{assignment_id}/progress/` selects the actual session account; there is no learner selector.
- `GET /api/v1/assignments/{assignment_id}/progress/learners/?offset=0&limit=50` requires current owner/instructor authority. Default page size is 50, maximum 100, within the assignment's 100 lifetime participation cap.

Rows contain assignment/version/user identifiers, `state`, `eligibility_state`, nullable `latest_submission` and nullable `latest_assessment`. A submission summary contains its ID, assignment submission number, timestamp and source-manifest hash. An assessment summary contains publication ID, manual status, timestamp and `assessment_kind: "manual"`. No source, comments, email address, private draft metadata or project grant is returned.

Own progress additionally returns advisory `can_submit`. This checks only that actor's current eligible work/source and ordinary server submission policy. Failure of that advisory check cannot erase history, authorize a new submission or prevent confirmation of an already committed original nonce. Teacher rows omit another learner's source-write availability and add only a safe display label.

A verified active workspace member without a participation can read their own published-version projection as `not_started` / `not_offered` / `can_submit: false`. Reading allocates no participation or notification row. Their participant socket becomes available only after a real lifetime participation exists.

## Eligibility and refresh

`eligibility_state` is separate from assessment history. Its values are `not_offered`, `invited`, `expired`, `declined`, `withdrawn`, `revoked`, `unavailable`, `team_pending`, `policy_ineligible`, `eligible` and `archived`. Current membership, verification, participation, exact team consent/approval and pinned version policy determine it. An `eligible` historical subject does not by itself promise a new write: deadline, Source and capacity checks remain server-owned.

[Private learning updates](learning-updates.md) invalidate visible progress views after committed facts change. Focus/known-expiry/periodic authorized HTTP reads also repair time-derived availability because a deadline can pass without a new generation. Refresh must retain the mounted editor, chosen submission source, local feedback draft and original pending command.

Implementation: [progress selectors](../../apps/api/code_along/learning/progress.py), [HTTP views](../../apps/api/code_along/learning/progress_api.py), [DTOs](../../apps/api/code_along/learning/progress_dto.py) and [generated contracts](../../packages/api-client/src/schema.d.ts).

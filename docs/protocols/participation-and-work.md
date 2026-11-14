# Assignment participation, teams and fresh work

This describes the M4.2 backend. [Assignments](assignments.md) publish frozen material; reading it does not enroll a learner or grant access to a teacher's live project. Implementation and acceptance evidence belongs in the [M4 validation record](../architecture/m4-validation.md).

## Separate authorities

Every endpoint requires an active verified account/session and current workspace membership. Unsafe methods retain same-origin CSRF protection. Responses are private/no-store. Workspace owners/instructors administer assignment offers and teams; global staff status, source ownership, project grants, UUID knowledge and source capabilities grant no learning authority.

An invitation is an in-app offer to an existing verified workspace member. Only its authenticated recipient can accept it. There is no external email, bearer token or automatic self-enrollment path. Acceptance is distinct from consent to a particular team roster and from the teacher's approval of that roster. A source viewer or mentor becomes eligible only through these explicit participation actions.

Ordinary ownership and project grants govern live source. A teaching role never bypasses those checks. An explicit **Create team work** action creates a new actor-owned project and editor grants to the other approved, consenting roster members, atomically. Invitations, acceptance, approval, roster changes and withdrawal do not themselves share or change any existing source project.

## HTTP API

Paths have prefix `/api/v1`; exact request/response fields are in the [generated contract](../api/openapi.json), [DTOs](../../apps/api/code_along/learning/participation_dto.py) and [API projections](../../apps/api/code_along/learning/participation_api.py).

| Method and assignment-relative path                 | Behavior                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /assignments/{a}/participations/`              | Teacher's bounded participation roster.                                                                          |
| `POST /assignments/{a}/participations/`             | Offer participation to `{recipient_id}`; an existing terminal/expired row also requires its `expected_revision`. |
| `GET /assignments/{a}/participation/`               | The current user's own record; `404` when none exists.                                                           |
| `POST /assignments/{a}/participation/accept/`       | Recipient accepts an unexpired offer using `expected_revision`.                                                  |
| `POST /assignments/{a}/participation/decline/`      | Recipient declines their offer.                                                                                  |
| `POST /assignments/{a}/participation/withdraw/`     | Recipient ends accepted participation.                                                                           |
| `POST /assignments/{a}/participations/{p}/revoke/`  | Teacher revokes a scoped participation.                                                                          |
| `GET /assignments/{a}/teams/`                       | Teacher lists teams, including archived records.                                                                 |
| `POST /assignments/{a}/teams/`                      | Teacher creates a named team.                                                                                    |
| `GET /assignments/{a}/teams/{t}/`                   | Teacher or a currently offered member reads this team's minimal roster.                                          |
| `PATCH /assignments/{a}/teams/{t}/`                 | Teacher CAS rename/archive/restore; cannot directly set approval or members.                                     |
| `POST /assignments/{a}/teams/{t}/members/`          | Teacher offers an accepted participation this team; exact team/participation revisions required.                 |
| `DELETE /assignments/{a}/teams/{t}/members/{p}/`    | Teacher or that recipient removes the team assignment; exact revisions are query parameters.                     |
| `POST /assignments/{a}/teams/{t}/approval/`         | Teacher approves the exact displayed roster revision.                                                            |
| `POST /assignments/{a}/participation/team-consent/` | Recipient consents to their offered team and exact displayed roster.                                             |
| `GET, POST /assignments/{a}/works/`                 | Read authorized work projections or explicitly create version-pinned fresh work.                                 |
| `GET /assignments/{a}/works/{w}/`                   | Authorized minimal work detail, with source projection only after ordinary project authorization.                |

Collections return `{items,count}` with `limit=1..100` (default 50) and `offset=0..100000`. Team list/detail accept an optional exact `assignment_version_id` to calculate that version's policy eligibility; omitting it returns `version_eligibility:null`. The team list otherwise accepts only pagination. Work listing accepts literal `mine=true|false` (default true) and `include_retired=true|false` (default false); `mine=false` requires current teaching authority.

JSON revisions are strict safe positive integers; booleans, floats and strings are rejected. DELETE revision query values are positive decimal strings within the same bound. UUIDs are canonical. Unknown fields are rejected. The existing 256 KiB bounded learning JSON parser applies; no source-upload endpoint or global body-limit increase is introduced.

## Participation and roster consent

[Participation services](../../apps/api/code_along/learning/participation_services.py) persist `invited`, `accepted`, `declined`, `withdrawn` or `revoked`. An expired invitation remains historically `invited`, with derived `effective_state:expired`; it cannot be accepted. Offers last seven days. Reinvitation reuses the same unique assignment/user record, requires current CAS and clears prior acceptance/consent. An accepted participation does not expire when its original invitation date passes.

An exact repeated accept/decline/withdraw/revoke returns the current resource only when its state and revision prove that same transition completed with no intervening row mutation. Other stale revisions return `409`. Teachers cannot accept on another user's behalf. Archive blocks new acceptance and new work while preserving authorized reads and consent-reducing decline/withdraw/revoke actions.

[Team services](../../apps/api/code_along/learning/team_services.py) keep a separate roster generation, teaching approval and each member's explicit consent. Membership is bounded to six accepted participants. Any composition change invalidates both affected teams' approval/consent, increments their roster generations and retires their active work. Remaining members receive fresh bounded offers for the changed roster; no consent is renewed automatically. Naming alone preserves the roster. Archive and restore invalidate the roster rather than reviving old consent or retired work.

Explicitly re-offering a member their existing team also starts a fresh roster generation, renews offers, clears approval/consent and retires active work. This lets teachers renew an expired unconsented offer; it is not a read-only resend. A UI exposing that action must explain the consequences before execution.

`consent_ready` requires two through six accepted, currently active/verified members, exact current-roster consent from each and teacher approval of that roster. Team-offer expiry gates giving new consent; already-consented unchanged rosters remain valid after their original offer date passes. `version_eligibility` separately checks the selected version's individual/team mode and maximum size. A new publication cannot change an old version's policy or invalidate otherwise unchanged consent.

## Fresh work and source access

[Work creation](../../apps/api/code_along/learning/work_services.py) accepts exactly:

```text
client_request_id, assignment_version_id, expected_participation_revision,
expected_team_roster_revision, project_name, sharing
```

Individual work requires `sharing:private` and a null team revision. Team work requires `sharing:approved_team_editors` and the exact displayed roster revision. The server derives all subject identities and grant recipients; clients cannot supply owners, participants, project IDs, grants or source.

The selected version must be the current publication for a new creation. Its immutable starter, reviewed runtime/helper and complete file hashes are verified without fetching the teacher's live room. The internal [fresh-project builder](../../apps/api/code_along/projects/frozen_projects.py) allocates new project/file/document identities, generation 1 and the matching entrypoint. Exact starter source becomes immutable initial source for genuinely new documents. The existing Node initialization path creates canonical binary state once; the browser never seeds a shared room from REST plaintext.

For team work, the creating accepted member owns the new project; every other approved, consenting member gets one ordinary editor grant. The creator gets no redundant grant row. Project/files/documents, exact grants, Work, immutable WorkMember intent and the ordinary source-project event commit together. Late actual session/hash, teaching where applicable, membership and verification checks prevent partial authorization after preparation. Failure rolls back the entire creation.

Work stays pinned to its original immutable version A when B is published. A's instructions, checks, runtime/helper, deadline and later attempt policy remain A's. A can continue under current participation, roster and ordinary source authority. Starting B explicitly creates fresh identities and does not overwrite or automatically retire A. Deadline passage restricts later submission, not reading or practice work.

WorkMember records the exact creation-time owner/editor intent and historical learning visibility. It is not current source authority or a future graded-participant list. Current/former included members can read their limited old work record while remaining workspace members. A newly added teammate cannot read an older work record merely by joining the mutable team. Teachers can read learning metadata, while project ID/name/role appears only after current ordinary project authorization.

Withdrawal, revocation and composition change retire affected bindings without changing old source ownership/grants. A successor starts again from the frozen published starter. The previous owner may retain independently authorized old source but has no implicit access to the successor. The UI must explain this distinction before explicit team creation and successor work. Existing project transfer/revoke controls remain the way to change old project access.

Ownership transfer within the eligible subject can preserve a work binding. If the current owner moves outside it, only an explicit authorized fresh-work action can retire that unavailable binding and create a fresh starter project. It cannot copy the new outsider owner's current code or repair ownership/grants. Losing one source grant alone does not permit taking over another member's still-valid work.

## Retry, bounds and transaction order

Work creation nonces are unique per assignment/actor. Compact SHA-256 JSON binds protocol/version, assignment/version/actor, server-derived subject identity, displayed roster/participation revisions, exact project name and explicit sharing intent. On a committed retry, historical subject identity comes from the original Work, not today's mutable roster. The same request returns the same currently authorized projection before new-creation version/eligibility/capacity checks. A changed payload with the same nonce returns `409`; an original retired work remains retired. Retries never create a second project or restore a removed source grant.

| Permanent retained-record limit                           | `409` code                 |
| --------------------------------------------------------- | -------------------------- |
| 100 participations/assignment, including terminal records | `participation_capacity`   |
| 50 teams/assignment, including archives                   | `team_capacity`            |
| Six members/team                                          | `team_roster_capacity`     |
| 200 work records/assignment, including retired work       | `assignment_work_capacity` |

An existing active subject/version returns `work_already_exists` and an authorized minimal work identity. These permanent conflicts have no `Retry-After`; the unchanged ordinary 120/minute throttle remains transient `429`. No automatic offline mutation replay or pruning is added.

Mutations lock workspace → assignment → teams by UUID → participations by UUID → work by UUID → source projects. Bounded existing child rows are locked before mutation. Publication is serialized by the same workspace/assignment locks. Runtime-row waits and preparation are followed by actual authority rechecks; no external capture or Python execution occurs under these locks.

Normal workspace removal runs the existing pure owner/project guards first, then the learning invalidation hook, then ordinary project-grant cleanup and membership deactivation, inside one workspace transaction. A failed guard changes no learning state. Removing and rejoining without any intervening learning read cannot revive old participation/consent/work. Unrelated workspace renames, project ACL changes or teaching-role changes that retain active membership do not invalidate consent.

Direct trusted SQL/admin flag changes are outside that product transition hook. Authoritative inactive/unverified checks deny access immediately, but administrators needing the same no-revival semantics across disable/reactivate must invoke the learning invalidation service in their controlled workspace transaction. A lazy read is not a substitute for deactivation cleanup.

## Database and verification boundaries

[Models](../../apps/api/code_along/learning/models.py), [model migration](../../apps/api/code_along/learning/migrations/0003_participation_teams_work.py) and [integrity migration](../../apps/api/code_along/learning/migrations/0004_work_integrity.py) enforce scoped assignment/workspace/team/participation/version/project pairs, safe revisions, subject XOR, active-work uniqueness and immutable nonce/source identities. Work can retire once and never reactivate. WorkMember updates/deletes are rejected; inserts enforce the bounded matching owner/editor/roster intent. SQL `NULL` cannot bypass required pair checks. The restricted collaboration role has no access to these four learning tables.

[Functional/race tests](../../apps/api/code_along/learning/tests/test_participation.py) and [database integrity tests](../../apps/api/code_along/learning/tests/test_work_integrity.py) cover recipient/CSRF/role denial, exact source and fresh identities, consent/roster transitions, A/B continuity, historical retry privacy, late session rollback, membership remove/rejoin, concurrent creation/withdrawal/capacity and migration restoration. Use only the [disposable PostgreSQL harness](../operations/postgres-tests.md); never the primary database.

M4.2 creates no submissions, assessments or private learning notifications. Successful UI actions explicitly refetch scoped REST state until M4.6. Ordinary new-project events remain ordinary project events; participation and private teaching data never enter those source-project groups.

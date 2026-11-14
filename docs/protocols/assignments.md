# Assignment authoring and immutable publication

This describes the implemented M4.1 backend contract. Integration evidence belongs in the [M4 validation record](../architecture/m4-validation.md).
Assignments publish frozen instructions, hints, optional visible Python checks and a named starter revision to active workspace members.
Reading a published assignment is not enrollment, submission eligibility or permission to open the source project's live code.

## Authority and visibility

Every endpoint requires an active verified Django account/session; unsafe methods retain same-origin CSRF protection.
Responses are private/no-store. Share capabilities, project grants, global staff flags and UUID knowledge grant no assignment authority.
[Assignment policies](../../apps/api/code_along/learning/policies.py) require a current active workspace owner or instructor for authoring.
The creator is provenance, rather than a private owner who excludes other current teachers.

Teachers can see drafts and published assignments. Other active members see only assignments with a published version.
Learner summaries use the published title, never the teacher's next draft title, unpublished instructions or edit timestamps.
Prior published versions remain readable after newer publication or assignment/source-project archival.
Workspace removal denies assignment reads; archived assignments/workspaces retain ordinary authorized reading.
Authoring and new publication require an open workspace and unarchived assignment; archive/restore requires teaching authority and an open workspace.

## HTTP API

Paths below have prefix `/api/v1`. Exact DTOs and operation identifiers are in the [generated OpenAPI contract](../api/openapi.json).
[API views and projections](../../apps/api/code_along/learning/api.py) and [serializers](../../apps/api/code_along/learning/dto.py) implement the boundary.

| Method and path                                             | Behavior                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /workspaces/{workspace}/assignments/`                  | Visible summaries; defaults to excluding archived assignments.                      |
| `POST /workspaces/{workspace}/assignments/`                 | Teacher creates a draft from `{title}`; returns `201` and its summary.              |
| `GET /assignments/{assignment}/`                            | Scoped summary and current published-version summary.                               |
| `PATCH /assignments/{assignment}/`                          | Teacher archive/restore using `{expected_revision, archived}`.                      |
| `GET /assignments/{assignment}/draft/`                      | Teacher-only current draft and authoring revision.                                  |
| `PATCH /assignments/{assignment}/draft/`                    | Teacher CAS patch; no implicit publication.                                         |
| `GET /assignments/{assignment}/versions/`                   | Published-version summaries, newest number first.                                   |
| `POST /assignments/{assignment}/versions/`                  | Publish `{expected_revision, client_request_id}`; `201` new, `200` committed retry. |
| `GET /assignments/{assignment}/versions/{version}/`         | Exact immutable published detail.                                                   |
| `GET /assignments/{assignment}/versions/{version}/starter/` | Authorized immutable revision manifest/source, without a live project grant.        |

Collections return `{items, count}`. Paging is `limit=1..100` (default 50), `offset=0..100000`.
Assignment discovery accepts `include_archived=true|false` literally; including archives never bypasses visibility.
Draft patches accept one or more of `title`, `instructions`, `hints`, `public_checks_source`, `starter_revision_id`,
`submission_mode`, `max_attempts`, `max_team_size` and `due_at`, together with `expected_revision`.
The server derives the starter project and origin; clients cannot submit project/workspace/authority fields independently.
Null starter revision clears both starter references. Null checks means no visible checks; null due date means no deadline.
Submission policy stores individual/team mode, 1–100 attempts, size 1 for individual or 2–6 for team, and fixed late policy `reject`.
These policy values are published metadata in M4.1; no participation or submission operation is implemented by them.

## Draft CAS and publication retry

Authoring revisions are strict JSON integers from 1 through 9007199254740991; strings, floats and booleans are rejected.
Every successful draft patch increments the revision, including equal-value changes. Empty patches and unknown fields are rejected.
Archive/restore also uses CAS and increments that same revision. A stale revision returns `409` without replacing current content.

[Publication services](../../apps/api/code_along/learning/services.py) lock workspace, assignment and, for first disclosure, the starter project.
They validate the frozen artifact/runtime, lock the runtime profile, allocate `max(number) + 1` and compute bounded metadata.
An actual session/auth-hash and current-teacher recheck occurs after potential waits and metadata preparation, before insertion.
Publication, metadata counter, current-version pointer and authoring revision commit together; failure leaves no partial publication.
There is no Node/network call or Python execution inside this transaction.

The nonce is unique per assignment and publisher. After current session/teaching authorization, the same nonce and original
`expected_revision` return the original immutable version, even after subsequent drafts, publication or archival.
This is a read retry: it grants no new source disclosure, consumes no capacity and does not restore an archived assignment.
Changing the expected revision with that nonce returns `409`. A new nonce still requires current CAS/open-state checks.
Future/null due dates are validated against server UTC for a new publication; retries return the original stored policy.

## Frozen starter authority

First publication of a private starter revision requires both teaching authority and current ordinary ownership of its same-workspace project.
Explicit source editors/viewers cannot disclose it; an actor without ordinary project access receives the existing scoped `404` denial.
The starter must be an existing `shared_room_capture` revision. M4.1 never captures or REST-saves the current live room as a shortcut.

A co-teacher can instead reuse the **exact H already published to this same assignment**, without a live project grant.
The service checks this assignment's immutable versions first, then matches revision/project/workspace, manifest, runtime and helper identities.
It does not query the private live project to authorize that path or obtain its current file list, project name, ticket or socket.
The server-derived origin labels it `Published starter — version N` using assignment-version metadata.
That authority never extends to a newer private H2, another assignment's private revision or the source project's live code.
Published starter reads use immutable revision files; later live edits, renames, runtime changes or source-project archival cannot replace H.

## Exact content and identities

[Canonical contracts](../../apps/api/code_along/learning/contracts.py) preserve accepted prose/source bytes: strict UTF-8, no NUL or lone surrogates.
Nonblank checks use the [shared fixed blank set](../../apps/api/code_along/common/text.py), rather than differing Python/JavaScript trimming rules.
Labels reject Unicode control/format/surrogate characters and count Unicode codepoints. Instructions and Python source are not normalized.
Title is at most 120 codepoints; instructions at most 32768 UTF-8 bytes, with nonblank instructions required at publication.
There are at most eight unique ordered hints: title at most 80 codepoints, body at most 4096 bytes, total bodies at most 16384 bytes.
Visible checks are null or nonblank Python source at most 16384 bytes, publicly inspectable as practice input without trusted grading authority.

The `code-along.public-checks` v1 manifest contains language `python`, exact source, its SHA-256 and the SHA-256 of compact UTF-8 JSON:

```text
["code-along.public-checks", 1, "python", source_sha256, source]
```

The assignment content digest is separate from both the revision v1 source digest and the existing RunManifest v2 digest.
Its fixed-order array binds assignment/version number, exact title/instructions/ordered hints, starter revision/digest,
frozen runtime identity, helper release, optional checks digest, submission mode/attempt/size policy and canonical UTC due date/`reject`.
`content_digest` is the authoritative field ordering; server publisher/profile/time remain separately immutable provenance.
The frozen runtime includes reviewed runtime ID/manifest digest, Pyodide engine/version and Python version, plus the stored runtime manifest.
The helper identity is the reviewed `code-along-python-helpers-v1` release and its exact source digest, validated against the starter.
New publication requires an enabled reviewed matching runtime; historical reads retain the originally published identities.

## Bounds, accounting and persistence

`AssignmentJSONParser` reads at most 256 KiB plus one overflow byte before parsing, independent of a claimed content length.
Oversized or excessively nested JSON returns a bounded `400`; decoded field bounds remain separate. No global upload limit is raised.
UUIDs are canonical strings; timestamps require an explicit timezone and are returned as UTC `Z` without losing microseconds.

| Permanent limit                                          | `409` code                          |
| -------------------------------------------------------- | ----------------------------------- |
| 100 assignments/workspace, including drafts and archives | `assignment_capacity`               |
| 50 immutable versions/assignment                         | `assignment_version_capacity`       |
| 256 KiB serialized metadata/version                      | `assignment_version_metadata_limit` |
| 4 MiB accumulated published metadata/assignment          | `assignment_metadata_capacity`      |

These responses contain `{code, detail}`, no `Retry-After`, and do not imply that waiting frees immutable capacity.
The existing ordinary 120/minute user throttle remains transient `429` with `Retry-After`; stale CAS is a separate `409` conflict.
Original authorized committed retries are checked before new-publication limits and never double-charge bytes or a version slot.

`metadata_size` uses the explicit fixed `METADATA_V1_FIELDS` encoding: all original stored identities/content, publisher/time/nonce/source revision,
runtime manifest/helper/check identities and content digest, excluding its own size field and referenced starter file source.
Encoding is compact sorted-key JSON with `ensure_ascii=False`, canonical UUIDs and UTC timestamps, stable after JSONB storage.
Future operational columns must not retroactively change v1 charges. The assignment counter equals the sum of retained version charges.
Starter files are protected references under existing revision budgets; publication does not duplicate source, Yjs state or checkpoints.

[Models](../../apps/api/code_along/learning/models.py) and [integrity migration](../../apps/api/code_along/learning/migrations/0002_publication_integrity.py)
enforce workspace/assignment/project/revision parent pairs and a deferred current-version-to-assignment binding.
An UPDATE/DELETE trigger makes published rows immutable; its function uses a fixed `pg_catalog` search path and qualified objects.
Database range/text-byte checks supplement service validation. The restricted Node collaboration role has no access to assignment tables.

## Verification and later units

Follow [disposable PostgreSQL setup](../operations/postgres-tests.md) first; tests use owned disposable clusters, never the primary database.
From the repository root, with its pinned uv environment and `CODE_ALONG_POSTGRES_BIN` configured:

```sh
uv run --locked --offline python -m pytest apps/api/code_along/learning/tests apps/api/code_along/chat/tests/test_chat.py apps/api/code_along/collaboration/tests/test_storage_schema.py -q
uv run --locked --offline python -m pytest -q
uv run --locked --offline mypy
corepack pnpm api:generate
```

The [tests](../../apps/api/code_along/learning/tests/) cover immutable exact bytes, scoped reads, co-teacher H/H2 separation, actual session races,
CSRF/Origin, bounded JSON, parent constraints, migration reversal/restoration, concurrent CAS/capacity and transactional rollback.
Conservative metadata limits can be dominated by field limits; valid-row lower-limit tests exercise capacity logic without claiming unreachable boundary fixtures.
M4.2+ participation/consent/teams/work creation, browser practice execution, private submissions, manual feedback, progress and learning notifications remain later units.
Reading/publication creates no enrollment, source grant, learning project or private learning event in project notification groups.

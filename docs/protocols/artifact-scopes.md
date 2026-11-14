# Project and submission artifact boundaries

M4.4a establishes an artifact-scope boundary before application submissions are implemented. It adds no private artifact creation/read endpoint, assessment behavior or new source capability. Existing project history, source sharing, published starters and fresh learning work retain their existing APIs and authorization.

## Scope is independent from source ownership

`ProjectRevision` stores immutable source bundles, with two exact database-valid tuples:

| Artifact scope | Provenance                  | Manifest version | Intended authority                                                                                     |
| -------------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| `project`      | `shared_room_capture`       | 1                | Ordinary project history, explicit source shares and published starters under their existing policies. |
| `submission`   | `client_submitted_snapshot` | 1                | Reserved for separately authorized frozen submissions in the next implementation unit.                 |

Project scope does not mean anonymous access. Ordinary source roles, explicit capabilities and assignment publication still govern that audience. Submission scope must never inherit access from a source owner/editor/viewer, mentor, WorkMember snapshot or source capability. A teaching role does not turn an ordinary history/share endpoint into a private-artifact endpoint.

Scope and provenance are immutable after insertion. The storage provenance field is widened to 32 characters for the 25-character private provenance; the existing public DTO still permits only `shared_room_capture`. Clients cannot supply artifact scope or the operational scope columns through public request bodies, and these columns do not appear in public responses.

## Public history and source boundaries

[Project artifact predicates](../../apps/api/code_along/projects/revision_scopes.py) require project scope, shared-room provenance and manifest version 1 in addition to the caller's existing authority. They apply before history list/count, known-UUID detail/manifest/export, public capture retry, byte/count budgets, copy and snapshot-sharing targets. A known private artifact UUID remains unavailable through these routes even to its live source owner. Private artifacts do not consume or reveal named-history slots/bytes and do not emit a public `revision.created` event.

The nonce namespace is `(project, author, client_request_id, artifact_scope)`. Public and private artifacts can therefore use the same project/actor/UUID independently. The named-history retry lookup remains project-scoped and cannot return a private artifact or treat it as an existing public request.

Source-share listing, count, active-share budget and token resolution use the same defensive target predicate: live targets remain live; snapshot targets must be project-scoped revisions. Resolution rejects a private target before returning its metadata/source. Existing expiry, recipient, actual-session and source policies remain in force. Revocation can still reduce a malformed grant without returning its target.

## Published starters and fresh work

[Learning selectors](../../apps/api/code_along/learning/selectors.py) guard version lists, current published summaries, draft projections and explicit version/starter reads. [Starter selection/publication](../../apps/api/code_along/learning/services.py) scopes both first-disclosure and already-published reuse. A co-teacher's exact previously published H still needs no live project/grant/file query; a private H2 cannot be substituted.

[Fresh work creation](../../apps/api/code_along/learning/work_services.py) independently requires a project-scoped published starter before validating its runtime/manifest and invoking the internal fresh-project builder. A Work or team relationship creates no private-artifact authority. Version A continuity and current participation/source authorization remain unchanged.

`revision_manifest()` remains an internal integrity serializer, rather than an authorization API. It can serialize either valid artifact after an appropriate domain wrapper authorizes that read. The internal `create_from_manifest()` similarly accepts an already-authorized validated bundle and performs no raw revision-UUID lookup. Neither function is exposed as an alternate private-read/copy route.

## Database relationships and immutable bytes

[Projects migration 0010](../../apps/api/code_along/projects/migrations/0010_revision_artifact_scope.py) adds the scope/provenance pairing check, scoped nonce uniqueness and unique `(id, project, artifact_scope)`. `ShareGrant.revision_scope` is a nonnull constant `project`; its deferred composite foreign key binds revision, source project and scope. Existing live/null versus snapshot/read constraints remain.

[Learning migration 0005](../../apps/api/code_along/learning/migrations/0005_starter_artifact_scope.py) adds constant `project` fields and scoped composite foreign keys for draft and published starters. Nullable draft references still require the existing matched pair. Work additionally has a unique `(id, assignment, workspace, assignment_version, project)` parent tuple for a later submission relationship.

Forward migration uses constant-default column addition and varchar widening. It does not update old revision/file/version rows, disable immutable triggers, convert private data into project history or recalculate original hashes. The v1 source-manifest encoding and fixed assignment metadata accounting exclude these operational columns; exact source/runtime/helper/content identities and prior charges remain unchanged.

The dependency order is:

```text
projects0009 → projects0010
learning0004 + projects0010 → learning0005
later submissions initial migration → both scope foundations
```

There is no projects→learning/submissions cycle. A future private application write must depend on both scope leaves and bind its own constant submission scope before it can insert artifacts.

## Safe reversal

Both scope migrations end with a forward no-op whose reverse guard executes first. If any private/non-project artifact exists, reversal raises `IrreversibleError` before dropping a scope relationship, column/check or narrowing provenance. Data is not deleted, retagged or exposed to make reversal succeed.

Both guards are required because Django may unapply the dependent learning migration before projects, and a multi-migration plan is not one atomic transaction. The next submission migration must separately protect its frozen participant/authority records before any reverse drops those tables. This foundation does not claim that later migration is already implemented.

## Verification

[Privacy/constraint tests](../../apps/api/code_along/projects/tests/test_artifact_scope.py) exercise ordinary source/teaching/staff/foreign roles, actual copy-route resolution and public-copy controls, same-actor nonce separation, named-history count/byte isolation, source capabilities, pending invalid-target hiding and named deferred FK/check rejection. Internal fixture insertion is confined to disposable tests; it is not an application private-write path.

[Migration tests](../../apps/api/code_along/projects/tests/test_artifact_scope_migrations.py) reverse and restore public-only data with historical models, compare exact manifests/fixed publication charges and enabled triggers, and exercise both actual reverse guards with private data while asserting no `ALTER`/`DROP` precedes refusal. [Restricted-role tests](../../apps/api/code_along/collaboration/tests/test_storage_schema.py) verify actual Node-role denial of revision/file tables and artifact-scope metadata.

Use the [owned disposable PostgreSQL harness](../operations/postgres-tests.md), never the primary database. Full implementation evidence and remaining exact-submission work are tracked in the [M4 validation record](../architecture/m4-validation.md).

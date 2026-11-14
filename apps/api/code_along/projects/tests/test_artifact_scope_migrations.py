import io

import pytest
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.contracts import METADATA_V1_FIELDS, metadata_size
from code_along.learning.models import AssignmentVersion
from code_along.learning.tests.test_assignments import publish, ready_assignment
from code_along.projects.models import ProjectRevision
from code_along.projects.revision_services import revision_manifest
from code_along.projects.tests.test_artifact_scope import private_artifact
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.exceptions import IrreversibleError
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test.utils import CaptureQueriesContext

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]

PROJECT_SCOPE = ("projects", "0010_revision_artifact_scope")
LEARNING_SCOPE = ("learning", "0005_starter_artifact_scope")
OLD = [("projects", "0009_project_event_sequence"), ("learning", "0004_work_integrity")]
SCOPED_FKS = {
    "share_revision_artifact_scope",
    "assignment_draft_revision_scope",
    "assignment_version_revision_scope",
}


@pytest.fixture(autouse=True)
def reviewed_catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def active_scope_constraints() -> set[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname=ANY(%s)",
            [list(SCOPED_FKS)],
        )
        return {row[0] for row in cursor.fetchall()}


def immutable_triggers() -> dict[str, str]:
    names = [
        "immutable_project_revision",
        "immutable_revision_file",
        "immutable_assignment_version",
    ]
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY(%s)", [names]
        )
        return dict(cursor.fetchall())


def test_forward_defaults_preserve_public_bytes_hashes_and_fixed_publication_charges_through_safe_reverse() -> (
    None
):
    project, client, assignment = ready_assignment()
    response = publish(client, assignment)
    assert response.status_code == 201
    version = AssignmentVersion.objects.get(id=response.json()["id"])
    revision = version.starter_revision
    before = revision_manifest(revision)
    version_before = {name: getattr(version, name) for name in METADATA_V1_FIELDS}
    charge_before = metadata_size(version)
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    triggers = immutable_triggers()
    assert triggers == {name: "O" for name in triggers} and len(triggers) == 3
    try:
        executor.migrate(OLD)
        historical = MigrationExecutor(connection).loader.project_state(OLD).apps
        old_revision = historical.get_model(
            "projects", "ProjectRevision"
        )._default_manager.get(id=revision.id)
        old_version = historical.get_model(
            "learning", "AssignmentVersion"
        )._default_manager.get(id=version.id)
        assert (
            old_revision.provenance == "shared_room_capture"
            and old_revision.manifest_sha256 == before["sha256"]
        )
        assert old_revision.files.get().source == before["files"][0]["source"]
        assert {
            name: getattr(old_version, name) for name in METADATA_V1_FIELDS
        } == version_before
        assert immutable_triggers() == triggers
        MigrationExecutor(connection).migrate(leaves)
        restored = ProjectRevision.objects.get(id=revision.id)
        restored_version = AssignmentVersion.objects.get(id=version.id)
        assert (
            restored.artifact_scope == "project"
            and restored_version.starter_scope == "project"
        )
        assert revision_manifest(restored) == before
        assert {
            name: getattr(restored_version, name) for name in METADATA_V1_FIELDS
        } == version_before
        assert (
            metadata_size(restored_version)
            == charge_before
            == restored_version.metadata_bytes
        )
        assert (
            active_scope_constraints() == SCOPED_FKS
            and immutable_triggers() == triggers
        )
        project.refresh_from_db()
        assert project.revisions.count() == 1
        call_command(
            "makemigrations",
            check=True,
            dry_run=True,
            verbosity=0,
            stdout=io.StringIO(),
        )
    finally:
        MigrationExecutor(connection).migrate(leaves)


def test_both_reverse_guards_refuse_before_dropping_any_boundary_with_private_artifacts() -> (
    None
):
    _, client, assignment = ready_assignment()
    response = publish(client, assignment)
    assert response.status_code == 201
    version = AssignmentVersion.objects.get(id=response.json()["id"])
    private = private_artifact(version.starter_revision)
    exact = revision_manifest(private)
    before_triggers = immutable_triggers()
    with (
        CaptureQueriesContext(connection) as queries,
        pytest.raises(IrreversibleError, match="Private artifacts"),
    ):
        MigrationExecutor(connection).migrate([("learning", "0004_work_integrity")])
    assert not any(
        query["sql"].lstrip().upper().startswith(("ALTER ", "DROP "))
        for query in queries.captured_queries
    )
    assert active_scope_constraints() == SCOPED_FKS
    # Exercise the projects migration's actual reverse operation separately. A normal
    # planner reaches the learning guard first; neither leaf may rely on the other.
    executor = MigrationExecutor(connection)
    before_state = executor.loader.project_state(OLD)
    project_migration = executor.loader.get_migration(*PROJECT_SCOPE)
    with (
        CaptureQueriesContext(connection) as queries,
        pytest.raises(IrreversibleError, match="Private artifacts"),
    ):
        executor.unapply_migration(before_state, project_migration)
    assert not any(
        query["sql"].lstrip().upper().startswith(("ALTER ", "DROP "))
        for query in queries.captured_queries
    )
    for app, name in [PROJECT_SCOPE, LEARNING_SCOPE]:
        assert MigrationRecorder.Migration.objects.filter(app=app, name=name).exists()
    assert (
        active_scope_constraints() == SCOPED_FKS
        and immutable_triggers() == before_triggers
    )
    private.refresh_from_db()
    assert (
        private.artifact_scope == "submission"
        and private.provenance == "client_submitted_snapshot"
    )
    assert revision_manifest(private) == exact
    with pytest.raises(IntegrityError), transaction.atomic():
        ProjectRevision.objects.filter(id=private.id).update(
            artifact_scope="project", provenance="shared_room_capture"
        )


def test_scope_constraints_are_deferred_and_immutable_parent_key_is_database_unique() -> (
    None
):
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname=ANY(%s)",
            [list(SCOPED_FKS)],
        )
        rows = cursor.fetchall()
        assert {name for name, _, _ in rows} == SCOPED_FKS
        assert all(deferred and initially for _, deferred, initially in rows)
        cursor.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='work_submission_parent' AND connamespace='public'::regnamespace"
        )
        assert (
            cursor.fetchone()[0]
            == "UNIQUE (id, assignment_id, workspace_id, assignment_version_id, project_id)"
        )
        cursor.execute(
            "SELECT character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='projects_projectrevision' AND column_name='provenance'"
        )
        assert cursor.fetchone()[0] == 32

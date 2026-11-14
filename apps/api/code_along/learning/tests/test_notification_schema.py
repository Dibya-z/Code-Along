import importlib
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.db.migrations.exceptions import IrreversibleError
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    LearningNotificationStream,
)
from code_along.learning.tests.test_participation import learner, prepared
from code_along.projects.revision_services import revision_manifest
from code_along.projects.tests.test_artifact_scope import (
    constraint_name,
    private_artifact,
)
from code_along.workspaces.models import Workspace, WorkspaceMembership

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]
TARGET = ("learning", "0006_learning_notification_streams")
PREVIOUS = ("learning", "0005_starter_artifact_scope")


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def test_populated_migration_backfills_every_lifetime_state_in_bounded_batches_idempotently() -> (
    None
):
    source, teacher, assignment = prepared()
    executor = MigrationExecutor(connection)
    leaves = executor.loader.graph.leaf_nodes()
    try:
        executor.migrate([PREVIOUS])
        old = MigrationExecutor(connection).loader.project_state([PREVIOUS]).apps
        OldAssignment = old.get_model("learning", "Assignment")
        OldParticipation = old.get_model("learning", "AssignmentParticipation")
        assignments = [OldAssignment.objects.get(id=assignment.id)] + [
            OldAssignment.objects.create(
                workspace_id=source.workspace_id,
                created_by_id=assignment.created_by_id,
                draft_title=f"Legacy assignment {i}",
            )
            for i in range(2)
        ]
        users = [
            User(
                id=uuid.uuid4(),
                email=f"backfill-{i}@example.test",
                display_name=f"Backfill learner {i}",
                password="!",
            )
            for i in range(201)
        ]
        User.objects.bulk_create(users)
        WorkspaceMembership.objects.bulk_create(
            [
                WorkspaceMembership(
                    workspace=source.workspace, user=user, role="learner"
                )
                for user in users
            ]
        )
        states = ["invited", "accepted", "declined", "withdrawn", "revoked"]
        now = timezone.now()
        records = [
            OldParticipation(
                assignment_id=assignments[i // 67].id,
                workspace_id=source.workspace_id,
                user_id=user.id,
                invited_by_id=assignment.created_by_id,
                state=states[i % 5],
                accepted_at=now if states[i % 5] == "accepted" else None,
                ended_at=now
                if states[i % 5] in {"declined", "withdrawn", "revoked"}
                else None,
            )
            for i, user in enumerate(users)
        ]
        OldParticipation.objects.bulk_create(records)
        MigrationExecutor(connection).migrate(leaves)
        assert (
            LearningNotificationStream.objects.filter(
                audience_user__isnull=True
            ).count()
            == 3
        )
        assert (
            LearningNotificationStream.objects.filter(
                audience_user__isnull=False
            ).count()
            == 201
        )
        assert set(
            LearningNotificationStream.objects.filter(
                participation__isnull=False
            ).values_list("participation_id", flat=True)
        ) == {record.id for record in records}
        assert not LearningNotificationStream.objects.exclude(
            head_generation=0,
            published_generation=0,
            claim_generation=None,
            lock_token=None,
            locked_until=None,
            attempts=0,
            last_error_code="",
        ).exists()
        identities = set(
            LearningNotificationStream.objects.values_list("id", flat=True)
        )
        migration = importlib.import_module(
            "code_along.learning.migrations.0006_learning_notification_streams"
        )
        state = MigrationExecutor(connection).loader.project_state(leaves)
        migration.backfill_streams(state.apps, SimpleNamespace(connection=connection))
        assert (
            set(LearningNotificationStream.objects.values_list("id", flat=True))
            == identities
        )
    finally:
        MigrationExecutor(connection).migrate(leaves)


def test_stream_reversal_refuses_private_artifact_before_any_ddl_or_source_change() -> (
    None
):
    source, teacher, assignment = prepared()
    version = assignment.current_version
    assert version is not None
    artifact = private_artifact(version.starter_revision)
    before = revision_manifest(artifact)
    executor = MigrationExecutor(connection)
    migration = executor.loader.get_migration(*TARGET)
    before_state = executor.loader.project_state([PREVIOUS])
    with (
        CaptureQueriesContext(connection) as queries,
        pytest.raises(IrreversibleError, match="Retained private submissions"),
    ):
        executor.unapply_migration(before_state, migration)
    assert not any(
        query["sql"].lstrip().upper().startswith(("ALTER ", "DROP "))
        for query in queries.captured_queries
    )
    assert MigrationRecorder.Migration.objects.filter(
        app=TARGET[0], name=TARGET[1]
    ).exists()
    assert LearningNotificationStream.objects.count() == 1
    artifact.refresh_from_db()
    assert revision_manifest(artifact) == before


@pytest.mark.parametrize(
    "case,expected",
    [
        ("workspace", "learning_stream_assignment_scope"),
        ("participation", "learning_stream_participation_scope"),
        ("user", "learning_stream_participation_scope"),
        ("pair", "learning_stream_audience_pair"),
    ],
)
def test_stream_scope_uses_valid_existing_mismatched_parents(
    case: str, expected: str
) -> None:
    source, teacher, published = prepared()
    user, client = learner(source, "stream-scope-user")
    different, _ = learner(source, "stream-scope-different")
    # These are valid pre-backfill domain parents, with no conflicting stream.
    assignment = Assignment.objects.create(
        workspace=source.workspace,
        created_by=published.created_by,
        draft_title="Valid scope parent",
    )
    other_assignment = Assignment.objects.create(
        workspace=source.workspace,
        created_by=published.created_by,
        draft_title="Different valid parent",
    )
    record = AssignmentParticipation.objects.create(
        assignment=assignment,
        workspace=source.workspace,
        user=user,
        invited_by=published.created_by,
    )
    other = AssignmentParticipation.objects.create(
        assignment=other_assignment,
        workspace=source.workspace,
        user=user,
        invited_by=published.created_by,
    )
    workspace = Workspace.objects.create(
        name="Other valid workspace", created_by=published.created_by
    )
    values: dict[str, Any] = {
        "assignment": assignment,
        "workspace": source.workspace,
        "participation": record,
        "audience_user": user,
    }
    if case == "workspace":
        values["workspace"] = workspace
    elif case == "participation":
        values["participation"] = other
    elif case == "user":
        values["audience_user"] = different
    else:
        values["participation"] = None
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        LearningNotificationStream.objects.create(**values)
        if case != "pair":
            with connection.cursor() as cursor:
                cursor.execute(f"SET CONSTRAINTS {expected} IMMEDIATE")
    assert constraint_name(error.value) == expected


def test_null_teaching_audience_is_unique_and_existing_identity_cannot_be_retargeted() -> (
    None
):
    source, teacher, assignment = prepared()
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        LearningNotificationStream.objects.create(
            assignment=assignment, workspace=source.workspace
        )
    assert constraint_name(error.value) == "learning_stream_audience"
    other_assignment = Assignment.objects.create(
        workspace=source.workspace,
        created_by=assignment.created_by,
        draft_title="Existing second parent",
    )
    stream = LearningNotificationStream.objects.get(assignment=assignment)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        LearningNotificationStream.objects.filter(id=stream.id).update(
            assignment=other_assignment
        )
    assert constraint_name(error.value) == "learning_stream_identity_immutable"

import uuid
from typing import Any

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.exceptions import IrreversibleError
from django.db.migrations.executor import MigrationExecutor
from django.test.utils import CaptureQueriesContext

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.models import AssignmentWork
from code_along.learning.tests.test_assignments import write
from code_along.learning.tests.test_participation import enroll, learner, work_body
from code_along.projects.models import ProjectRevision, RevisionFile
from code_along.projects.tests.test_artifact_scope import (
    constraint_name,
)
from code_along.projects.tests.test_history import create_revision
from code_along.submissions.models import Submission, SubmissionParticipant
from code_along.submissions.tests.test_submissions import candidate, fixture, url
from code_along.workspaces.tests.test_workspaces import signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def committed() -> Submission:
    teacher, client, assignment, work = fixture()
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    return Submission.objects.get(id=response.json()["id"])


@pytest.mark.parametrize(
    "operation",
    [
        "source",
        "participant",
        "delete_submission",
        "delete_participant",
        "source_scope",
    ],
)
def test_immutable_private_rows_and_frozen_participants_cannot_change(
    operation: str,
) -> None:
    record = committed()
    with (
        pytest.raises(IntegrityError),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        if operation == "source":
            cursor.execute(
                "UPDATE projects_revisionfile SET source='tampered' WHERE revision_id=%s",
                [record.revision_id],
            )
        elif operation == "source_scope":
            cursor.execute(
                "UPDATE projects_projectrevision SET artifact_scope='project',provenance='shared_room_capture' WHERE id=%s",
                [record.revision_id],
            )
        elif operation == "participant":
            cursor.execute(
                "UPDATE submissions_submissionparticipant SET display_name='different' WHERE submission_id=%s",
                [record.id],
            )
        elif operation == "delete_submission":
            cursor.execute(
                "DELETE FROM submissions_submission WHERE id=%s", [record.id]
            )
        else:
            cursor.execute(
                "DELETE FROM submissions_submissionparticipant WHERE submission_id=%s",
                [record.id],
            )
    assert Submission.objects.filter(id=record.id).exists()
    assert record.revision.files.get().source.startswith("\ufeff")


def clone(record: Submission, **changes: Any) -> Submission:
    fields = {
        field.attname: getattr(record, field.attname)
        for field in record._meta.concrete_fields
        if field.name != "id"
    }
    nonce = uuid.uuid4()
    if "revision_id" in changes:
        artifact = ProjectRevision.objects.get(id=changes["revision_id"])
    else:
        # Build a valid private insert with unchanged source/hashes, never
        # retagging an immutable row or masking a target FK with bad provenance.
        revision_fields = {
            field.attname: getattr(record.revision, field.attname)
            for field in record.revision._meta.concrete_fields
            if field.name not in {"id", "created_at", "client_request_id"}
        }
        with transaction.atomic():
            artifact = ProjectRevision.objects.create(
                **revision_fields, client_request_id=nonce
            )
            RevisionFile.objects.bulk_create(
                [
                    RevisionFile(
                        revision=artifact,
                        file_id=file.file_id,
                        document_id=file.document_id,
                        generation=file.generation,
                        path=file.path,
                        source=file.source,
                        source_sha256=file.source_sha256,
                        source_bytes=file.source_bytes,
                    )
                    for file in record.revision.files.all()
                ]
            )
    fields.update(
        revision_id=artifact.id,
        client_request_id=nonce,
        assignment_submission_number=record.assignment_submission_number + 1,
        subject_attempt_number=record.subject_attempt_number + 1,
    )
    fields.update(changes)
    return Submission(**fields)


def test_private_submission_requires_scope_qualified_revision_parent() -> None:
    record = committed()
    public = create_revision(record.project, signed_in(record.author))
    assert (
        public.project_id == record.project_id and public.author_id == record.author_id
    )
    assert public.artifact_scope == "project"
    forged = clone(record, revision_id=public.id)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        forged.save(force_insert=True)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS submission_revision_binding IMMEDIATE")
    assert constraint_name(error.value) == "submission_revision_binding"


def test_submission_work_five_tuple_and_participant_parent_identity_are_real_fks() -> (
    None
):
    record = committed()
    other, other_client = learner(record.project, "valid-different-parent")
    teacher = signed_in(record.assignment.created_by)
    other_participation = enroll(teacher, record.assignment, other, other_client)
    response = write(
        other_client,
        f"/api/v1/assignments/{record.assignment_id}/works/",
        work_body(record.assignment, other),
    )
    assert response.status_code == 201, response.content
    other_work = AssignmentWork.objects.get(id=response.json()["id"])
    assert other_work.project_id != record.project_id
    assert other_work.assignment_id == record.assignment_id
    assert other_work.assignment_version_id == record.assignment_version_id
    assert other_work.workspace_id == record.workspace_id
    forged = clone(record, work_id=other_work.id)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        forged.save(force_insert=True)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS submission_work_binding IMMEDIATE")
    assert constraint_name(error.value) == "submission_work_binding"
    participant = record.participants.get()
    participant_parent = clone(record)
    fields = {
        field.attname: getattr(participant, field.attname)
        for field in participant._meta.concrete_fields
        if field.name != "id"
    }
    assert other_participation.user_id == other.id
    assert participant.participation_id != other_participation.id
    # Every single-column parent exists; only participation's user binding is wrong.
    fields.update(
        submission_id=participant_parent.id, user_id=other.id, attempt_number=2
    )
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        participant_parent.save(force_insert=True)
        SubmissionParticipant.objects.create(**fields)
        with connection.cursor() as cursor:
            cursor.execute(
                "SET CONSTRAINTS submission_participation_identity IMMEDIATE"
            )
    assert constraint_name(error.value) == "submission_participation_identity"


@pytest.mark.parametrize("target", ["0001_initial", "zero"])
def test_private_authority_reverse_refuses_before_any_schema_ddl(target: str) -> None:
    record = committed()
    with CaptureQueriesContext(connection) as queries, pytest.raises(IrreversibleError):
        call_command("migrate", "submissions", target, verbosity=0)
    assert not any(
        item["sql"].lstrip().upper().startswith(("ALTER ", "DROP "))
        for item in queries.captured_queries
    )
    assert (
        Submission.objects.get(id=record.id)
        .revision.files.get()
        .source.startswith("\ufeff")
    )


def test_empty_private_schema_reverses_and_restores_without_drift() -> None:
    leaves = MigrationExecutor(connection).loader.graph.leaf_nodes()
    try:
        call_command("migrate", "submissions", "zero", verbosity=0)
        assert "submissions_submission" not in connection.introspection.table_names()
    finally:
        MigrationExecutor(connection).migrate(leaves)
    assert "submissions_submission" in connection.introspection.table_names()
    call_command("makemigrations", check=True, dry_run=True, verbosity=0)


def test_team_submission_pair_rejects_null_roster_in_sql_check() -> None:
    record = committed()
    forged = clone(record, team_id=uuid.uuid4(), team_roster_revision=None)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        forged.save(force_insert=True)
    assert constraint_name(error.value) == "submission_team_pair"


def test_partial_frozen_set_cannot_commit_and_later_valid_append_cannot_gain_source_access() -> (
    None
):
    from code_along.submissions.tests.test_policy import team_fixture

    teacher, first, second, member, assignment, work = team_fixture()
    response = write(first, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    record = Submission.objects.get(id=response.json()["id"])
    assert record.participant_count == record.participants.count() == 2
    original = list(
        record.participants.values(
            "id", "user_id", "participation_id", "display_name", "attempt_number"
        )
    )
    # A complete parent from an actual commit rejects a valid same-assignment
    # third user/participation even though the global hard maximum would allow6.
    third, third_client = learner(record.project, "valid-late-participant")
    participation = enroll(teacher, assignment, third, third_client)
    detail = f"/api/v1/assignments/{assignment.id}/submissions/{record.id}/"
    assert third_client.get(detail, secure=True).status_code == 404
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        SubmissionParticipant.objects.create(
            submission=record,
            assignment=assignment,
            assignment_version=record.assignment_version,
            participation=participation,
            user=third,
            display_name=third.display_name,
            attempt_number=1,
        )
    assert constraint_name(error.value) == "submission_participants_sealed"
    assert (
        list(
            record.participants.values(
                "id", "user_id", "participation_id", "display_name", "attempt_number"
            )
        )
        == original
    )
    assert third_client.get(detail, secure=True).status_code == 404
    assert (
        first.get(detail, secure=True).json()["manifest"] == response.json()["manifest"]
    )
    # A new parent with one of its two valid frozen members cannot commit.
    incomplete = clone(record)
    fields = {
        field.attname: getattr(record.participants.first(), field.attname)
        for field in SubmissionParticipant._meta.concrete_fields
        if field.name != "id"
    }
    fields.update(submission_id=incomplete.id, attempt_number=2)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        incomplete.save(force_insert=True)
        SubmissionParticipant.objects.create(**fields)
    assert constraint_name(error.value) == "submission_participant_set_complete"
    assert not Submission.objects.filter(id=incomplete.id).exists()
    assert record.participants.count() == 2


def test_empty_frozen_set_cannot_commit() -> None:
    record = committed()
    incomplete = clone(record)
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        incomplete.save(force_insert=True)
    assert constraint_name(error.value) == "submission_participant_set_complete"
    assert not Submission.objects.filter(id=incomplete.id).exists()


def test_six_authoritative_participants_complete_the_set_in_one_transaction() -> None:
    from code_along.learning.tests.test_participation import prepared, ready_team

    source, teacher, assignment = prepared("team")
    people = [learner(source, f"complete-set-{number}") for number in range(6)]
    ready_team(teacher, assignment, people)
    owner, client = people[0]
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, owner),
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    record = Submission.objects.get(id=response.json()["id"])
    assert record.participant_count == record.participants.count() == 6
    assert set(record.participants.values_list("user_id", flat=True)) == {
        user.id for user, _ in people
    }

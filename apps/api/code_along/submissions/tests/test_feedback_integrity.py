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
from code_along.learning.contracts import digest
from code_along.projects.tests.test_artifact_scope import constraint_name
from code_along.submissions import feedback_services
from code_along.submissions.models import (
    FeedbackPublication,
    InstructorFeedback,
    Submission,
)
from code_along.submissions.tests.test_feedback import (
    base,
    feedback_fixture,
    publish,
    save,
)
from code_along.submissions.tests.test_submissions import candidate, url
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def second_submission(client: Any, record: Submission) -> Submission:
    response = client.post(
        url(record.assignment, record.work),
        candidate(record.work, "second frozen H"),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    return Submission.objects.get(id=response.json()["id"])


def test_another_teacher_publishes_exact_draft_without_becoming_its_editor() -> None:
    teacher, learner, record = feedback_fixture()
    other = person("second-manual-reviewer")
    WorkspaceMembership.objects.create(
        workspace=record.workspace, user=other, role="instructor"
    )
    second = signed_in(other)
    saved = save(teacher, record).json()
    response = publish(second, record)
    assert response.status_code == 201, response.content
    assert response.json()["publisher"]["id"] == str(other.id)
    draft = second.get(base(record) + "draft/", secure=True).json()
    assert draft["last_edited_by"] == saved["last_edited_by"]
    assert draft["updated_at"] == saved["updated_at"] and draft["revision"] == 2


@pytest.mark.parametrize("change", ["publisher", "comments", "delete"])
def test_publication_provenance_and_text_are_immutable(change: str) -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    assert publish(teacher, record).status_code == 201
    publication = FeedbackPublication.objects.get()
    other = person("valid-other-publisher")
    WorkspaceMembership.objects.create(
        workspace=record.workspace, user=other, role="instructor"
    )
    with (
        pytest.raises(IntegrityError) as error,
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        if change == "publisher":
            cursor.execute(
                "UPDATE submissions_feedbackpublication SET published_by_id=%s WHERE id=%s",
                [other.id, publication.id],
            )
        elif change == "comments":
            cursor.execute(
                "UPDATE submissions_feedbackpublication SET comments='different' WHERE id=%s",
                [publication.id],
            )
        else:
            cursor.execute(
                "DELETE FROM submissions_feedbackpublication WHERE id=%s",
                [publication.id],
            )
    assert constraint_name(error.value) == "feedback_publication_immutable"


def test_valid_feedback_parents_and_current_pointer_cannot_cross_submissions() -> None:
    teacher, learner, first = feedback_fixture()
    second = second_submission(learner, first)
    for record in (first, second):
        assert save(teacher, record).status_code == 200
        assert publish(teacher, record).status_code == 201
    one = InstructorFeedback.objects.get(submission=first)
    two = InstructorFeedback.objects.get(submission=second)
    publication = one.publications.get()
    fields = {
        field.attname: getattr(publication, field.attname)
        for field in publication._meta.concrete_fields
        if field.name != "id"
    }
    nonce = uuid.uuid4()
    fields.update(
        feedback_id=two.id,
        number=2,
        client_request_id=nonce,
        request_sha256=digest(
            [
                "code-along.feedback-request",
                1,
                str(first.id),
                str(publication.published_by_id),
                1,
                str(nonce),
            ]
        ),
        content_sha256=digest(
            [
                "code-along.manual-feedback",
                1,
                str(first.id),
                str(first.assignment_version_id),
                2,
                publication.assessment_status,
                publication.comments,
            ]
        ),
    )
    forged = FeedbackPublication(**fields)
    forged.metadata_bytes = feedback_services.publication_metadata(
        forged, first.assignment_version_id
    )
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        forged.save(force_insert=True)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS feedback_publication_scope IMMEDIATE")
    assert constraint_name(error.value) == "feedback_publication_scope"
    other_publication = two.publications.get()
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        InstructorFeedback.objects.filter(id=one.id).update(
            revision=one.revision + 1, current_publication=other_publication
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS feedback_current_publication IMMEDIATE")
    assert constraint_name(error.value) == "feedback_current_publication"


def test_draft_identity_cannot_retarget_a_valid_unused_submission() -> None:
    teacher, learner, first = feedback_fixture()
    second = second_submission(learner, first)
    assert save(teacher, first).status_code == 200
    draft = InstructorFeedback.objects.get()
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        InstructorFeedback.objects.filter(id=draft.id).update(
            submission=second, revision=2
        )
    assert constraint_name(error.value) == "feedback_identity_immutable"


def test_draft_scope_binds_valid_submission_to_its_real_assignment_and_workspace() -> (
    None
):
    teacher, learner, first = feedback_fixture()
    from code_along.learning import services as learning
    from code_along.workspaces import services as workspaces

    foreign_workspace = workspaces.create_workspace(
        first.assignment.created_by, "Valid foreign feedback parent"
    )
    foreign_assignment = learning.create_assignment(
        first.assignment.created_by,
        teacher.session.session_key,
        foreign_workspace.id,
        title="Foreign assignment",
    )
    assert (
        first.assignment_id != foreign_assignment.id
        and first.workspace_id != foreign_workspace.id
    )
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        InstructorFeedback.objects.create(
            submission=first,
            assignment=foreign_assignment,
            workspace=foreign_workspace,
            last_edited_by=first.assignment.created_by,
            draft_comments="valid",
            draft_assessment_status="reviewed",
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS feedback_submission_scope IMMEDIATE")
    assert constraint_name(error.value) == "feedback_submission_scope"


def test_feedback_reverse_guard_preserves_draft_publications_and_source_before_ddl() -> (
    None
):
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    assert publish(teacher, record).status_code == 201
    before = learner.get(base(record), secure=True).json()
    with (
        CaptureQueriesContext(connection) as queries,
        pytest.raises(IrreversibleError, match="Retained private"),
    ):
        call_command("migrate", "submissions", "0002", verbosity=0)
    assert not any(
        item["sql"].lstrip().upper().startswith(("ALTER ", "DROP "))
        for item in queries.captured_queries
    )
    assert learner.get(base(record), secure=True).json() == before
    assert record.revision.files.get().source.startswith("\ufeff")


def test_empty_feedback_leaf_reverses_restores_and_matches_model_state() -> None:
    leaves = MigrationExecutor(connection).loader.graph.leaf_nodes()
    try:
        call_command("migrate", "submissions", "0002", verbosity=0)
        assert (
            "submissions_feedbackpublication"
            not in connection.introspection.table_names()
        )
    finally:
        MigrationExecutor(connection).migrate(leaves)
    call_command("makemigrations", check=True, dry_run=True, verbosity=0)

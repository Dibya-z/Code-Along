import uuid
from typing import Any
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.db import connection
from django.test import Client
from django.test.utils import CaptureQueriesContext

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.events.models import OutboxEvent
from code_along.learning.contracts import digest
from code_along.learning.models import Assignment
from code_along.projects.models import Project
from code_along.submissions.models import (
    FeedbackPublication,
    InstructorFeedback,
    Submission,
    SubmissionAssignmentUsage,
    SubmissionWorkspaceUsage,
)
from code_along.submissions.tests.test_submissions import candidate, fixture, url
from code_along.workspaces.models import Workspace, WorkspaceMembership

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def feedback_fixture() -> tuple[Client, Client, Submission]:
    teacher, learner, assignment, work = fixture()
    response = learner.post(
        url(assignment, work),
        candidate(work),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    return teacher, learner, Submission.objects.get(id=response.json()["id"])


def base(record: Submission) -> str:
    return (
        f"/api/v1/assignments/{record.assignment_id}/submissions/{record.id}/feedback/"
    )


def save(
    teacher: Client,
    record: Submission,
    *,
    revision: int = 0,
    comments: str = "Keep exact feedback 🐍\r\n",
    status: str | None = "reviewed",
) -> Any:
    return teacher.patch(
        base(record) + "draft/",
        {
            "expected_revision": revision,
            "comments": comments,
            "assessment_status": status,
        },
        content_type="application/json",
        secure=True,
    )


def publish(
    teacher: Client, record: Submission, *, revision: int = 1, nonce: str | None = None
) -> Any:
    return teacher.post(
        base(record) + "publications/",
        {
            "expected_revision": revision,
            "client_request_id": nonce or str(uuid.uuid4()),
        },
        content_type="application/json",
        secure=True,
    )


def test_absent_draft_get_is_revision_zero_without_any_write() -> None:
    teacher, learner, record = feedback_fixture()
    response = teacher.get(base(record) + "draft/", secure=True)
    assert response.status_code == 200, response.content
    assert response.json() == {
        "submission_id": str(record.id),
        "revision": 0,
        "comments": "",
        "assessment_status": None,
        "last_edited_by": None,
        "updated_at": None,
    }
    assert (
        InstructorFeedback.objects.count() == FeedbackPublication.objects.count() == 0
    )
    assert learner.get(base(record), secure=True).json() == {"latest": None}
    assert learner.get(base(record) + "publications/", secure=True).json() == {
        "items": [],
        "count": 0,
    }


def test_draft_cas_exact_text_publications_and_corrections_preserve_private_source_and_public_parents() -> (
    None
):
    teacher, learner, record = feedback_fixture()
    parents = [
        (Project.objects, record.project_id),
        (Assignment.objects, record.assignment_id),
        (Workspace.objects, record.workspace_id),
        (Submission.objects, record.id),
    ]
    before = [
        model.filter(id=identifier).values().get() for model, identifier in parents
    ]
    usage_before = (
        SubmissionAssignmentUsage.objects.values_list(
            "count", "source_bytes", "metadata_bytes"
        ).get(),
        SubmissionWorkspaceUsage.objects.values_list(
            "count", "source_bytes", "metadata_bytes"
        ).get(),
    )
    events = OutboxEvent.objects.count()
    comments = "\ufeff  शिक्षक <b>text only</b> café e\u0301\r\n  "
    saved = save(teacher, record, comments=comments, status="needs_changes")
    assert saved.status_code == 200 and saved.json()["revision"] == 1, saved.content
    assert saved.json()["comments"] == comments
    assert save(teacher, record, comments="stale").status_code == 409
    with CaptureQueriesContext(connection) as queries:
        assert learner.get(base(record), secure=True).json() == {"latest": None}
        assert learner.get(base(record) + "publications/", secure=True).json() == {
            "items": [],
            "count": 0,
        }
    assert not any(
        '"submissions_instructorfeedback"' in item["sql"]
        for item in queries.captured_queries
    )
    first = publish(teacher, record)
    assert first.status_code == 201, first.content
    data = first.json()
    assert data["comments"] == comments and data["assessment_kind"] == "manual"
    assert data["content_sha256"] == digest(
        [
            "code-along.manual-feedback",
            1,
            str(record.id),
            str(record.assignment_version_id),
            1,
            "needs_changes",
            comments,
        ]
    )
    assert teacher.get(base(record) + "draft/", secure=True).json()["revision"] == 2
    assert (
        save(teacher, record, revision=2, comments="", status="complete").status_code
        == 200
    )
    second = publish(teacher, record, revision=3)
    assert (
        second.status_code == 201
        and second.json()["number"] == 2
        and second.json()["comments"] == ""
    ), second.content
    history = learner.get(base(record) + "publications/", secure=True).json()
    assert history["items"] == [second.json(), data] and history["count"] == 2
    assert learner.get(base(record), secure=True).json() == {"latest": second.json()}
    assert [
        model.filter(id=identifier).values().get() for model, identifier in parents
    ] == before
    assert OutboxEvent.objects.count() == events
    assert record.revision.files.get().source.startswith("\ufeffprint('chosen H')")
    assert (
        SubmissionAssignmentUsage.objects.get().count
        == SubmissionWorkspaceUsage.objects.get().count
        == 1
    )
    assert usage_before == (
        SubmissionAssignmentUsage.objects.values_list(
            "count", "source_bytes", "metadata_bytes"
        ).get(),
        SubmissionWorkspaceUsage.objects.values_list(
            "count", "source_bytes", "metadata_bytes"
        ).get(),
    )
    assert SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes == sum(
        FeedbackPublication.objects.values_list("metadata_bytes", flat=True)
    )


def test_publication_original_nonce_precedes_later_draft_publication_and_archived_parent_policy() -> (
    None
):
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    nonce = str(uuid.uuid4())
    first = publish(teacher, record, nonce=nonce)
    assert first.status_code == 201, first.content
    assert (
        save(
            teacher, record, revision=2, comments="correction", status="complete"
        ).status_code
        == 200
    )
    assert publish(teacher, record, revision=3).status_code == 201
    Assignment.objects.filter(id=record.assignment_id).update(
        archived_at=record.submitted_at
    )
    repeat = publish(teacher, record, revision=1, nonce=nonce)
    assert repeat.status_code == 200 and repeat.json() == first.json()
    assert (
        publish(teacher, record, revision=2, nonce=nonce).json()["code"]
        == "feedback_nonce_conflict"
    )
    assert teacher.get(base(record) + "draft/", secure=True).status_code == 409
    assert (
        save(teacher, record, revision=4).json()["code"]
        == "feedback_review_unavailable"
    )
    assert (
        publish(teacher, record, revision=4).json()["code"]
        == "feedback_review_unavailable"
    )
    assert learner.get(base(record), secure=True).status_code == 200
    WorkspaceMembership.objects.filter(
        workspace=record.workspace, user=record.assignment.created_by
    ).update(role="learner")
    assert publish(teacher, record, nonce=nonce).status_code == 403


@pytest.mark.parametrize("existing", [False, True])
def test_frozen_participant_teacher_denied_before_any_draft_lookup(
    existing: bool,
) -> None:
    teacher, learner, record = feedback_fixture()
    if existing:
        assert (
            save(
                teacher, record, comments="unpublished private teacher notes"
            ).status_code
            == 200
        )
    WorkspaceMembership.objects.filter(
        workspace=record.workspace, user=record.author
    ).update(role="instructor")
    with CaptureQueriesContext(connection) as queries:
        denied = [
            learner.get(base(record) + "draft/", secure=True),
            save(learner, record),
            publish(learner, record),
        ]
    assert all(response.status_code == 403 for response in denied)
    assert not any(
        '"submissions_instructorfeedback"' in item["sql"]
        or '"submissions_feedbackpublication"' in item["sql"]
        for item in queries.captured_queries
    )
    assert InstructorFeedback.objects.count() == int(existing)
    detail = learner.get(
        f"/api/v1/assignments/{record.assignment_id}/submissions/{record.id}/",
        secure=True,
    ).json()
    assert not detail["can_review"] and not any("draft" in key for key in detail)
    if existing:
        assert publish(teacher, record).status_code == 201
        assert (
            learner.get(base(record), secure=True).json()["latest"]["comments"]
            == "unpublished private teacher notes"
        )


def test_current_teacher_needs_no_live_source_queries_or_grants_to_review() -> None:
    teacher, learner, record = feedback_fixture()
    from code_along.projects.policies import visible_projects

    assert (
        not visible_projects(record.assignment.created_by)
        .filter(id=record.project_id)
        .exists()
    )
    with CaptureQueriesContext(connection) as queries:
        assert teacher.get(base(record) + "draft/", secure=True).status_code == 200
        assert save(teacher, record).status_code == 200
        assert publish(teacher, record).status_code == 201
        assert learner.get(base(record), secure=True).status_code == 200
        assert (
            teacher.get(base(record) + "publications/", secure=True).status_code == 200
        )
    forbidden = [
        '"projects_project"',
        '"projects_projectaccess"',
        '"projects_projectfile"',
        '"projects_revisionfile"',
        '"collaboration_documentstate"',
    ]
    assert not any(
        any(table in item["sql"] for table in forbidden)
        for item in queries.captured_queries
    )


@pytest.mark.parametrize(
    "body",
    [
        {"comments": "x", "assessment_status": "reviewed", "expected_revision": True},
        {"comments": "x", "assessment_status": "automatic", "expected_revision": 0},
        {
            "comments": "x",
            "assessment_status": "reviewed",
            "expected_revision": 0,
            "score": 10,
        },
        {"comments": "\0", "assessment_status": None, "expected_revision": 0},
        {"comments": "\ud800", "assessment_status": None, "expected_revision": 0},
        {"comments": "é" * 4097, "assessment_status": None, "expected_revision": 0},
        {
            "comments": "\ufeff\u00a0\u3000\r\n  ",
            "assessment_status": "reviewed",
            "expected_revision": 0,
        },
        {"comments": "", "assessment_status": "needs_changes", "expected_revision": 0},
    ],
)
def test_invalid_manual_commands_do_not_create_drafts(body: dict[str, Any]) -> None:
    teacher, learner, record = feedback_fixture()
    response = teacher.patch(
        base(record) + "draft/", body, content_type="application/json", secure=True
    )
    assert response.status_code == 400, response.content
    assert (
        InstructorFeedback.objects.count() == FeedbackPublication.objects.count() == 0
    )


def test_null_draft_status_cannot_publish_but_exact_8192_bytes_can() -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record, status=None, comments="").status_code == 200
    assert publish(teacher, record).json()["code"] == "feedback_draft_incomplete"
    exact = "é" * 4096
    assert (
        save(teacher, record, revision=1, status="reviewed", comments=exact).status_code
        == 200
    )
    response = publish(teacher, record, revision=2)
    assert response.status_code == 201 and response.json()["comments"] == exact, (
        response.content
    )


def test_draft_and_publication_responses_recheck_teacher_role_after_serialization() -> (
    None
):
    from code_along.submissions import feedback_api

    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    original = feedback_api.draft_data

    def demote(*args: Any, **kwargs: Any) -> Any:
        data = original(*args, **kwargs)
        WorkspaceMembership.objects.filter(
            workspace=record.workspace, user=record.assignment.created_by
        ).update(role="learner")
        return data

    with patch.object(feedback_api, "draft_data", side_effect=demote):
        denied = teacher.get(base(record) + "draft/", secure=True)
    assert (
        denied.status_code == 403
        and "Keep exact feedback" not in denied.content.decode()
    )


def test_source_owner_staff_cannot_review_and_frozen_history_survives_withdrawal_not_workspace_removal() -> (
    None
):
    from code_along.learning.participation_services import transition_participation
    from code_along.learning.tests.test_participation import learner as new_learner
    from code_along.projects import services as projects
    from code_along.workspaces import services as workspaces

    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    assert publish(teacher, record).status_code == 201
    other, other_client = new_learner(record.project, "ordinary-source-review-owner")
    projects.transfer_project(
        record.author, record.project_id, other.id, record.project.metadata_version
    )
    other.is_staff = True
    other.save(update_fields=["is_staff"])
    assert other_client.get(base(record), secure=True).status_code == 404
    assert (
        other_client.get(base(record) + "publications/", secure=True).status_code == 404
    )
    assert other_client.get(base(record) + "draft/", secure=True).status_code == 403
    participation = record.work.participation
    assert participation is not None
    transition_participation(
        record.author,
        learner.session.session_key,
        record.assignment_id,
        action="withdraw",
        expected_revision=participation.revision,
    )
    assert learner.get(base(record), secure=True).status_code == 200
    workspaces.update_member(
        record.assignment.created_by, record.workspace_id, record.author_id, remove=True
    )
    assert learner.get(base(record), secure=True).status_code in {403, 404}
    assert learner.get(base(record) + "publications/", secure=True).status_code in {
        403,
        404,
    }
    WorkspaceMembership.objects.filter(
        workspace=record.workspace, user=record.author
    ).update(active=True)
    assert learner.get(base(record), secure=True).status_code == 200
    assert learner.get(base(record) + "draft/", secure=True).status_code == 403


def test_manual_review_is_not_gated_by_pinned_submission_deadline() -> None:
    from datetime import timedelta

    from django.utils import timezone

    from code_along.learning.models import AssignmentWork
    from code_along.learning.tests.test_assignments import publish as publish_version
    from code_along.learning.tests.test_participation import work_body

    teacher, learner, old = feedback_fixture()
    assignment = old.assignment
    due = timezone.now() + timedelta(hours=1)
    response = teacher.patch(
        f"/api/v1/assignments/{assignment.id}/draft/",
        {"expected_revision": assignment.revision, "due_at": due.isoformat()},
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    assert publish_version(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    response = learner.post(
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, old.author),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    response = learner.post(
        url(assignment, work),
        candidate(work),
        content_type="application/json",
        secure=True,
    )
    assert response.status_code == 201, response.content
    record = Submission.objects.get(id=response.json()["id"])
    with patch(
        "code_along.submissions.feedback_services.timezone.now",
        return_value=due + timedelta(seconds=1),
    ):
        assert save(teacher, record).status_code == 200
        response = publish(teacher, record)
    assert response.status_code == 201, response.content


@pytest.mark.parametrize("route", ["latest", "history"])
def test_published_feedback_role_loss_during_serialization_does_not_leak_a_reply(
    route: str,
) -> None:
    from code_along.submissions import feedback_api

    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    assert publish(teacher, record).status_code == 201
    original = feedback_api.publication_data

    def demote(*args: Any, **kwargs: Any) -> Any:
        data = original(*args, **kwargs)
        WorkspaceMembership.objects.filter(
            workspace=record.workspace, user=record.assignment.created_by
        ).update(role="learner")
        return data

    with patch.object(feedback_api, "publication_data", side_effect=demote):
        response = teacher.get(
            base(record) + ("publications/" if route == "history" else ""), secure=True
        )
    assert response.status_code in {403, 404}, response.content
    assert "Keep exact feedback" not in response.content.decode()

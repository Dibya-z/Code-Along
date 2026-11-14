import hashlib
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
from code_along.learning.models import Assignment, AssignmentWork
from code_along.learning.tests.test_assignments import publish, write
from code_along.learning.tests.test_participation import (
    enroll,
    learner,
    prepared,
    ready_team,
    work_body,
)
from code_along.projects.models import Project, ProjectAccess, ProjectRevision
from code_along.projects.policies import visible_projects
from code_along.submissions.models import (
    Submission,
    SubmissionAssignmentUsage,
    SubmissionParticipant,
    SubmissionWorkspaceUsage,
)

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def fixture() -> tuple[Client, Client, Assignment, AssignmentWork]:
    source, teacher, assignment = prepared()
    user, client = learner(source, "submitter")
    enroll(teacher, assignment, user, client)
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, user),
    )
    assert response.status_code == 201, response.content
    return (
        teacher,
        client,
        assignment,
        AssignmentWork.objects.get(id=response.json()["id"]),
    )


def candidate(
    work: AssignmentWork,
    source: str = "\ufeffprint('chosen H')\r\n",
    *,
    nonce: str | None = None,
) -> dict[str, Any]:
    project = work.project
    runtime = {
        key: work.assignment_version.runtime_identity[key]
        for key in (
            "runtime_id",
            "manifest_sha256",
            "engine",
            "engine_version",
            "python_version",
        )
    }
    files = [
        {
            "file_id": str(file.id),
            "document_id": str(file.document.id),
            "generation": file.generation,
            "path": file.path,
            "source": source,
            "sha256": hashlib.sha256(source.encode()).hexdigest(),
        }
        for file in sorted(
            project.files.filter(deleted_at__isnull=True).select_related("document"),
            key=lambda f: f.path,
        )
    ]
    manifest = {
        "version": 2,
        "project_id": str(project.id),
        "source_kind": "project",
        "metadata_version": project.metadata_version,
        "entrypoint_file_id": str(project.entrypoint_file_id),
        "runtime": runtime,
        "stdin_mode": "batch",
        "files": files,
    }
    manifest["sha256"] = digest(manifest)
    return {
        "client_request_id": nonce or str(uuid.uuid4()),
        "manifest": manifest,
        "practice": None,
    }


def url(assignment: Assignment, work: AssignmentWork) -> str:
    return f"/api/v1/assignments/{assignment.id}/works/{work.id}/submissions/"


def test_exact_chosen_private_source_is_saved_once_without_public_leak() -> None:
    teacher, client, assignment, work = fixture()
    project = work.project
    project_before = dict(Project.objects.filter(id=project.id).values().get())
    assignment_before = dict(Assignment.objects.filter(id=assignment.id).values().get())
    events = OutboxEvent.objects.count()
    body = candidate(work)
    with patch(
        "code_along.projects.revision_services.capture",
        side_effect=AssertionError("No Node recapture"),
    ):
        response = write(client, url(assignment, work), body)
    assert response.status_code == 201, response.content
    data = response.json()
    assert data["manifest"] == body["manifest"]
    assert data["source_manifest_sha256"] == body["manifest"]["sha256"]
    assert data["artifact_manifest_sha256"] != data["source_manifest_sha256"]
    assert (
        data["artifact_scope"] == "submission"
        and data["provenance"] == "client_submitted_snapshot"
    )
    assert data["practice"] is None and not data["can_review"]
    assert (
        Submission.objects.count() == 1 and SubmissionParticipant.objects.count() == 1
    )
    assert OutboxEvent.objects.count() == events
    assert Project.objects.filter(id=project.id).values().get() == project_before
    assert (
        Assignment.objects.filter(id=assignment.id).values().get() == assignment_before
    )
    history = client.get(f"/api/v1/projects/{project.id}/revisions/", secure=True)
    assert history.status_code == 200 and history.json()["count"] == 0
    record = Submission.objects.get()
    assert record.revision.files.get().source == "\ufeffprint('chosen H')\r\n"
    assert record.metadata_bytes <= 16384
    assert (
        SubmissionAssignmentUsage.objects.get().count
        == SubmissionWorkspaceUsage.objects.get().count
        == 1
    )
    assert SubmissionWorkspaceUsage.objects.get().source_bytes == len(
        "\ufeffprint('chosen H')\r\n".encode()
    )
    teacher_detail = teacher.get(
        f"/api/v1/assignments/{assignment.id}/submissions/{record.id}/", secure=True
    )
    assert teacher_detail.status_code == 200 and teacher_detail.json()["can_review"]


def test_identical_retry_is_single_attempt_and_changed_body_conflicts() -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    first = write(client, url(assignment, work), body)
    assert first.status_code == 201, first.content
    retry = write(client, url(assignment, work), body)
    assert retry.status_code == 200 and retry.json() == first.json()
    changed = candidate(work, "print('different')", nonce=body["client_request_id"])
    response = write(client, url(assignment, work), changed)
    assert (
        response.status_code == 409
        and response.json()["code"] == "submission_nonce_conflict"
    )
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 1


def test_current_text_change_does_not_invalidate_chosen_h_but_structure_does() -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    # Source plaintext in the room is intentionally not a REST authority check.
    assert write(client, url(assignment, work), body).status_code == 201
    body = candidate(work)
    Project.objects.filter(id=work.project_id).update(
        metadata_version=work.project.metadata_version + 1
    )
    response = write(client, url(assignment, work), body)
    assert (
        response.status_code == 409
        and response.json()["code"] == "submission_structure_changed"
    )
    assert Submission.objects.count() == 1


def test_teacher_frozen_detail_and_discovery_make_no_live_source_queries() -> None:
    teacher, client, assignment, work = fixture()
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    with CaptureQueriesContext(connection) as queries:
        detail = teacher.get(
            f"/api/v1/assignments/{assignment.id}/submissions/{response.json()['id']}/",
            secure=True,
        )
        discovery = teacher.get(
            f"/api/v1/assignments/{assignment.id}/submissions/?assignment_version_id={work.assignment_version_id}",
            secure=True,
        )
    assert detail.status_code == discovery.status_code == 200
    assert discovery.json()["count"] == 1
    forbidden = [
        '"projects_project"',
        '"projects_projectfile"',
        '"projects_projectaccess"',
        '"collaboration_documentstate"',
    ]
    assert not any(
        any(table in item["sql"] for table in forbidden)
        for item in queries.captured_queries
    )


def test_ordinary_source_access_is_not_private_submission_authority() -> None:
    teacher, client, assignment, work = fixture()
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    outsider, other = learner(work.project, "source-only")
    ProjectAccess.objects.create(project=work.project, user=outsider, role="viewer")
    assert visible_projects(outsider).filter(id=work.project_id).exists()
    for path in (
        url(assignment, work),
        f"/api/v1/assignments/{assignment.id}/submissions/{response.json()['id']}/",
        f"/api/v1/assignments/{assignment.id}/submissions/",
    ):
        denied = other.get(path, secure=True)
        assert denied.status_code in {403, 404}, denied.content
    denied = write(other, url(assignment, work), candidate(work))
    assert denied.status_code in {403, 404}, denied.content


def test_work_a_can_submit_after_publication_b() -> None:
    teacher, client, assignment, work = fixture()
    old = work.assignment_version_id
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    assert old != assignment.current_version_id
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201 and response.json()[
        "assignment_version_id"
    ] == str(old), response.content


def test_team_viewer_is_eligible_and_freezes_actual_consented_roster() -> None:
    source, teacher, assignment = prepared("team")
    a, first = learner(source, "team-owner")
    b, second = learner(source, "team-viewer")
    ready_team(teacher, assignment, [(a, first), (b, second)])
    response = write(
        first, f"/api/v1/assignments/{assignment.id}/works/", work_body(assignment, a)
    )
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    ProjectAccess.objects.filter(project=work.project, user=b).update(role="viewer")
    response = write(second, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    assert {p["id"] for p in response.json()["participants"]} == {str(a.id), str(b.id)}
    assert response.json()["author"]["id"] == str(b.id)
    assert set(
        SubmissionParticipant.objects.values_list("attempt_number", flat=True)
    ) == {1}


@pytest.mark.parametrize(
    "field,value", [("practice", {}), ("extra", True), ("client_request_id", "invalid")]
)
def test_strict_body_and_evidence_fail_without_partial_private_rows(
    field: str, value: Any
) -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    body[field] = value
    response = write(client, url(assignment, work), body)
    assert response.status_code == 400, response.content
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0


def test_empty_source_is_valid_and_work_history_exposes_safe_availability() -> None:
    teacher, client, assignment, work = fixture()
    response = client.get(url(assignment, work), secure=True)
    assert response.status_code == 200, response.content
    assert (
        response.json()["items"] == [] and response.json()["availability"]["can_submit"]
    )
    body = candidate(work, "")
    assert write(client, url(assignment, work), body).status_code == 201
    assert SubmissionAssignmentUsage.objects.get().source_bytes == 0

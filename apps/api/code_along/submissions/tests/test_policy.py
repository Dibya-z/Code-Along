import copy
import uuid
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.utils import timezone

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.models import Assignment, AssignmentWork
from code_along.learning.tests.test_assignments import publish, write
from code_along.learning.tests.test_participation import (
    learner,
    prepared,
    ready_team,
    work_body,
)
from code_along.projects.models import ProjectAccess, ProjectRevision
from code_along.submissions import services
from code_along.submissions.models import (
    Submission,
    SubmissionAssignmentUsage,
    SubmissionParticipant,
    SubmissionWorkspaceUsage,
)
from code_along.submissions.tests.test_submissions import candidate, fixture, url

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def team_fixture() -> tuple[Any, Any, Any, Any, Assignment, AssignmentWork]:
    source, teacher, assignment = prepared("team")
    owner, first = learner(source, "policy-team-owner")
    member, second = learner(source, "policy-team-member")
    ready_team(teacher, assignment, [(owner, first), (member, second)])
    response = write(
        first,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, owner),
    )
    assert response.status_code == 201, response.content
    return (
        teacher,
        first,
        second,
        member,
        assignment,
        AssignmentWork.objects.get(id=response.json()["id"]),
    )


def test_source_grant_loss_denies_new_but_original_retry_and_frozen_read_survive() -> (
    None
):
    teacher, first, second, member, assignment, work = team_fixture()
    body = candidate(work)
    committed = write(second, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    ProjectAccess.objects.filter(project=work.project, user=member).delete()
    response = write(second, url(assignment, work), candidate(work))
    assert (
        response.status_code == 409
        and response.json()["code"] == "submission_source_unavailable"
    )
    retry = write(second, url(assignment, work), body)
    assert retry.status_code == 200 and retry.json() == committed.json()
    detail = second.get(
        f"/api/v1/assignments/{assignment.id}/submissions/{committed.json()['id']}/",
        secure=True,
    )
    assert detail.status_code == 200 and detail.json()["manifest"] == body["manifest"]


def test_withdrawal_preserves_original_read_but_not_new_eligibility() -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    committed = write(client, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    record = work.participation
    assert record is not None
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/participation/withdraw/",
        {"expected_revision": record.revision},
    )
    assert response.status_code == 200, response.content
    assert write(client, url(assignment, work), body).status_code == 200
    assert write(client, url(assignment, work), candidate(work)).status_code == 409
    assert (
        client.get(
            f"/api/v1/assignments/{assignment.id}/submissions/{committed.json()['id']}/",
            secure=True,
        ).status_code
        == 200
    )


def test_workspace_removal_denies_original_read_and_rejoin_does_not_revive_consent() -> (
    None
):
    from code_along.workspaces.models import WorkspaceMembership

    teacher, first, second, member, assignment, work = team_fixture()
    body = candidate(work)
    committed = write(second, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    workspace = assignment.workspace
    response = teacher.delete(
        f"/api/v1/workspaces/{workspace.id}/members/{member.id}/", secure=True
    )
    assert response.status_code == 204, response.content
    assert write(second, url(assignment, work), body).status_code in {403, 404}
    assert second.get(
        f"/api/v1/assignments/{assignment.id}/submissions/{committed.json()['id']}/",
        secure=True,
    ).status_code in {403, 404}
    WorkspaceMembership.objects.filter(workspace=workspace, user=member).update(
        active=True
    )
    assert write(second, url(assignment, work), body).status_code == 200
    assert write(second, url(assignment, work), candidate(work)).status_code == 409


def test_teacher_nonparticipant_cannot_submit_or_claim_subject_authority() -> None:
    teacher, client, assignment, work = fixture()
    response = write(teacher, url(assignment, work), candidate(work))
    assert (
        response.status_code == 409
        and response.json()["code"] == "submission_participation_unavailable"
    )
    assert Submission.objects.count() == 0


def test_actual_session_removed_after_all_inserts_rolls_back_every_write() -> None:
    teacher, client, assignment, work = fixture()
    body = services.prepare(candidate(work), work.id)
    from code_along.learning.participation_services import current_member

    real = current_member
    calls = 0

    def revoke(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 3:
            Session.objects.filter(session_key=client.session.session_key).delete()
        return real(*args, **kwargs)

    with patch.object(services, "current_member", side_effect=revoke):
        response = write(client, url(assignment, work), candidate(work))
    assert calls == 3 and response.status_code == 403, response.content
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0
    assert (
        SubmissionAssignmentUsage.objects.count()
        == SubmissionWorkspaceUsage.objects.count()
        == 0
    )
    assert body.manifest.source_bytes > 0


@pytest.mark.parametrize("failure", ["revision", "participant", "counter"])
def test_insert_failure_rolls_back_private_artifact_attempts_and_counters(
    failure: str,
) -> None:
    teacher, client, assignment, work = fixture()
    target = {
        "revision": "code_along.submissions.services.RevisionFile.objects.bulk_create",
        "participant": "code_along.submissions.services.SubmissionParticipant.objects.bulk_create",
        "counter": "code_along.submissions.services.SubmissionWorkspaceUsage.save",
    }[failure]
    with (
        patch(target, side_effect=RuntimeError("injected owned test write failure")),
        pytest.raises(RuntimeError),
    ):
        write(client, url(assignment, work), candidate(work))
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0
    assert (
        SubmissionAssignmentUsage.objects.count()
        == SubmissionWorkspaceUsage.objects.count()
        == 0
    )


@pytest.mark.parametrize(
    "kind",
    [
        "assignment_count",
        "workspace_count",
        "assignment_raw",
        "workspace_raw",
        "assignment_metadata",
        "workspace_metadata",
    ],
)
def test_permanent_bounded_capacity_has_distinct_codes_and_original_retry_survives(
    kind: str,
) -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    committed = write(client, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    assignment_usage = SubmissionAssignmentUsage.objects.get()
    workspace_usage = SubmissionWorkspaceUsage.objects.get()
    usage = assignment_usage if kind.startswith("assignment") else workspace_usage
    field, maximum = (
        ("count", 256 if kind.startswith("assignment") else 1024)
        if kind.endswith("count")
        else ("source_bytes", 33554432 if kind.startswith("assignment") else 134217728)
        if kind.endswith("raw")
        else ("metadata_bytes", 4194304 if kind.startswith("assignment") else 16777216)
    )
    setattr(usage, field, maximum)
    usage.save(update_fields=[field])
    response = write(client, url(assignment, work), candidate(work))
    expected = f"{'assignment' if kind.startswith('assignment') else 'workspace'}_submission_{'storage_capacity' if kind.endswith('raw') else 'capacity'}"
    assert response.status_code == 409 and response.json()["code"] == expected, (
        response.content
    )
    assert "Retry-After" not in response
    retry = write(client, url(assignment, work), body)
    assert retry.status_code == 200 and retry.json() == committed.json()
    assert Submission.objects.count() == 1


def test_at_exact_raw_cap_zero_byte_candidate_remains_possible() -> None:
    teacher, client, assignment, work = fixture()
    SubmissionAssignmentUsage.objects.create(
        assignment=assignment, workspace=assignment.workspace, source_bytes=33554432
    )
    SubmissionWorkspaceUsage.objects.create(
        workspace=assignment.workspace, source_bytes=134217728
    )
    availability = client.get(url(assignment, work), secure=True)
    assert (
        availability.status_code == 200
        and availability.json()["availability"]["can_submit"]
    )
    response = write(client, url(assignment, work), candidate(work, ""))
    assert response.status_code == 201, response.content


def test_chosen_body_ownership_and_non_source_evidence_nonce_changes() -> None:
    teacher, client, assignment, work = fixture()
    raw = candidate(work)
    selected = services.prepare(raw, work.id)
    expected = copy.deepcopy(raw)
    raw["manifest"]["files"][0]["source"] = "tampered caller object"
    raw["practice"] = {"kind": "fake"}
    record, created = services.submit(
        work.created_by, client.session.session_key, assignment.id, work.id, selected
    )
    assert (
        created
        and record.revision.files.get().source
        == expected["manifest"]["files"][0]["source"]
    )
    changed = copy.deepcopy(expected)
    changed["practice"] = {
        "kind": "run",
        "run_id": str(uuid.uuid4()),
        "source_manifest_sha256": changed["manifest"]["sha256"],
        "status": "failed",
    }
    response = write(client, url(assignment, work), changed)
    assert (
        response.status_code == 409
        and response.json()["code"] == "submission_nonce_conflict"
    )


def test_server_due_and_attempt_limit_use_pinned_version_and_do_not_gate_original_retry() -> (
    None
):
    teacher, client, assignment, work = fixture()
    due = timezone.now() + timedelta(hours=1)
    assignment.refresh_from_db()
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": assignment.revision,
            "max_attempts": 1,
            "due_at": due.isoformat(),
        },
        method="patch",
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, work.created_by),
    )
    assert response.status_code == 201, response.content
    fresh = AssignmentWork.objects.get(id=response.json()["id"])
    body = candidate(fresh)
    with patch("code_along.submissions.services.timezone.now", return_value=due):
        committed = write(client, url(assignment, fresh), body)
    assert committed.status_code == 201, committed.content
    with patch(
        "code_along.submissions.services.timezone.now",
        return_value=due + timedelta(microseconds=1),
    ):
        late = write(client, url(assignment, fresh), candidate(fresh))
        retry = write(client, url(assignment, fresh), body)
    assert (
        late.status_code == 409 and late.json()["code"] == "submission_deadline_passed"
    )
    assert retry.status_code == 200
    exhausted = write(client, url(assignment, fresh), candidate(fresh))
    assert (
        exhausted.status_code == 409
        and exhausted.json()["code"] == "submission_attempt_limit"
    )


@pytest.mark.parametrize("route", ["detail", "work", "assignment"])
def test_teacher_role_loss_during_serialization_denies_private_response(
    route: str,
) -> None:
    from code_along.submissions import api
    from code_along.workspaces.models import WorkspaceMembership

    teacher, client, assignment, work = fixture()
    response = write(client, url(assignment, work), candidate(work))
    assert response.status_code == 201, response.content
    real = api.detail_data if route == "detail" else api.summary_data

    def demote(*args: Any, **kwargs: Any) -> Any:
        value = real(*args, **kwargs)
        WorkspaceMembership.objects.filter(
            workspace=assignment.workspace, user_id=assignment.created_by_id
        ).update(role="learner")
        return value

    path = (
        f"/api/v1/assignments/{assignment.id}/submissions/{response.json()['id']}/"
        if route == "detail"
        else url(assignment, work)
        if route == "work"
        else f"/api/v1/assignments/{assignment.id}/submissions/"
    )
    with patch.object(
        api, "detail_data" if route == "detail" else "summary_data", side_effect=demote
    ):
        denied = teacher.get(path, secure=True)
    assert denied.status_code in {403, 404}, denied.content
    assert "chosen H" not in denied.content.decode()


@pytest.mark.parametrize("kind", ["run", "visible_checks"])
def test_evidence_object_key_order_is_not_a_different_nonce_request(kind: str) -> None:
    from code_along.learning.contracts import digest

    teacher, client, assignment, work = fixture()
    body = candidate(work)
    evidence: dict[str, Any] = {
        "kind": kind,
        "run_id": str(uuid.uuid4()),
        "source_manifest_sha256": body["manifest"]["sha256"],
        "status": "succeeded",
    }
    if kind == "visible_checks":
        version = work.assignment_version
        assert version.public_checks is not None
        checks = version.public_checks["sha256"]
        evidence.update(
            published_checks_sha256=checks,
            checks_sha256=checks,
            check_origin="published",
        )
        evidence["practice_manifest_sha256"] = digest(
            [
                "code-along.practice-manifest",
                1,
                str(assignment.id),
                str(version.id),
                version.content_sha256,
                body["manifest"]["sha256"],
                version.helper_release["release_id"],
                version.helper_release["source_sha256"],
                checks,
                checks,
                "published",
            ]
        )
    body["practice"] = evidence
    committed = write(client, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    body["practice"] = dict(reversed(list(evidence.items())))
    retry = write(client, url(assignment, work), body)
    assert retry.status_code == 200 and retry.json() == committed.json()


@pytest.mark.parametrize("change", ["inactive", "unverified"])
def test_peer_account_revocation_after_participant_inserts_rolls_back_every_private_write(
    change: str,
) -> None:
    from allauth.account.models import EmailAddress

    from code_along.accounts.models import User

    teacher, first, second, member, assignment, work = team_fixture()
    real = SubmissionParticipant.objects.bulk_create

    def revoke_after_insert(objects: Any, *args: Any, **kwargs: Any) -> Any:
        value = real(objects, *args, **kwargs)
        if change == "inactive":
            User.objects.filter(id=member.id).update(is_active=False)
        else:
            EmailAddress.objects.filter(user=member, primary=True).update(
                verified=False
            )
        return value

    with patch.object(
        SubmissionParticipant.objects, "bulk_create", side_effect=revoke_after_insert
    ):
        denied = write(first, url(assignment, work), candidate(work))
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "submission_participation_unavailable"
    ), denied.content
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 0
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 0
    assert (
        SubmissionAssignmentUsage.objects.count()
        == SubmissionWorkspaceUsage.objects.count()
        == 0
    )


@pytest.mark.parametrize("scope", ["ASSIGNMENT", "WORKSPACE"])
def test_reachable_actual_rows_obey_lowered_count_boundary_and_rollback(
    scope: str,
) -> None:
    from code_along.submissions import policies

    teacher, client, assignment, work = fixture()
    with patch.object(policies, f"{scope}_SUBMISSION_LIMIT", 2):
        for _ in range(2):
            accepted = write(client, url(assignment, work), candidate(work, ""))
            assert accepted.status_code == 201, accepted.content
        denied = write(client, url(assignment, work), candidate(work, ""))
    assert (
        denied.status_code == 409
        and denied.json()["code"] == f"{scope.lower()}_submission_capacity"
    )
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 2
    assert (
        SubmissionAssignmentUsage.objects.get().count
        == SubmissionWorkspaceUsage.objects.get().count
        == 2
    )
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 2


@pytest.mark.parametrize("scope", ["ASSIGNMENT", "WORKSPACE"])
def test_reachable_raw_exact_cap_accepts_zero_bytes_and_rejects_one_more(
    scope: str,
) -> None:
    from code_along.submissions import policies

    teacher, client, assignment, work = fixture()
    with patch.object(policies, f"{scope}_SOURCE_BYTES", 3):
        for source in ("abc", ""):
            accepted = write(client, url(assignment, work), candidate(work, source))
            assert accepted.status_code == 201, accepted.content
        available = client.get(url(assignment, work), secure=True)
        assert (
            available.status_code == 200
            and available.json()["availability"]["can_submit"]
        )
        denied = write(client, url(assignment, work), candidate(work, "d"))
    assert (
        denied.status_code == 409
        and denied.json()["code"] == f"{scope.lower()}_submission_storage_capacity"
    )
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 2
    assert (
        SubmissionAssignmentUsage.objects.get().source_bytes
        == SubmissionWorkspaceUsage.objects.get().source_bytes
        == 3
    )
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 2


@pytest.mark.parametrize("scope", ["ASSIGNMENT", "WORKSPACE"])
def test_reachable_retained_metadata_boundary_is_atomic(scope: str) -> None:
    from code_along.submissions import policies

    teacher, client, assignment, work = fixture()
    now = timezone.now().replace(microsecond=123456)
    with patch("code_along.submissions.services.timezone.now", return_value=now):
        accepted = write(client, url(assignment, work), candidate(work, ""))
        assert accepted.status_code == 201, accepted.content
        first_charge = Submission.objects.get().metadata_bytes
        with patch.object(policies, f"{scope}_METADATA_BYTES", first_charge * 2):
            second = write(client, url(assignment, work), candidate(work, ""))
            assert second.status_code == 201, second.content
            denied = write(client, url(assignment, work), candidate(work, ""))
    assert (
        denied.status_code == 409
        and denied.json()["code"] == f"{scope.lower()}_submission_capacity"
    )
    assert Submission.objects.count() == SubmissionParticipant.objects.count() == 2
    assert (
        SubmissionAssignmentUsage.objects.get().metadata_bytes
        == SubmissionWorkspaceUsage.objects.get().metadata_bytes
        == first_charge * 2
    )
    assert ProjectRevision.objects.filter(artifact_scope="submission").count() == 2


def test_declared_production_capacity_defaults_remain_fixed() -> None:
    from code_along.submissions import policies

    assert (
        policies.ASSIGNMENT_SUBMISSION_LIMIT,
        policies.WORKSPACE_SUBMISSION_LIMIT,
    ) == (256, 1024)
    assert (policies.ASSIGNMENT_SOURCE_BYTES, policies.WORKSPACE_SOURCE_BYTES) == (
        33554432,
        134217728,
    )
    assert (policies.ASSIGNMENT_METADATA_BYTES, policies.WORKSPACE_METADATA_BYTES) == (
        4194304,
        16777216,
    )


def test_runtime_catalogue_drift_is_scoped_conflict_and_availability_reason() -> None:
    from code_along.projects.models import RuntimeProfile

    teacher, client, assignment, work = fixture()
    body = candidate(work)
    RuntimeProfile.objects.filter(id=work.project.runtime_profile_id).update(
        manifest_sha256="a" * 64
    )
    available = client.get(url(assignment, work), secure=True)
    assert (
        available.status_code == 200
        and available.json()["availability"]["reason"] == "submission_runtime_changed"
    )
    denied = write(client, url(assignment, work), body)
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "submission_runtime_changed"
    )
    assert Submission.objects.count() == 0


def test_known_disabled_execution_profile_still_allows_existing_work_source_submission() -> (
    None
):
    from code_along.projects.models import RuntimeProfile

    teacher, client, assignment, work = fixture()
    body = candidate(work)
    RuntimeProfile.objects.filter(id=work.project.runtime_profile_id).update(
        enabled=False
    )
    available = client.get(url(assignment, work), secure=True)
    assert (
        available.status_code == 200 and available.json()["availability"]["can_submit"]
    )
    committed = write(client, url(assignment, work), body)
    assert committed.status_code == 201, committed.content
    assert committed.json()["manifest"] == body["manifest"]
    detail = client.get(
        f"/api/v1/assignments/{assignment.id}/submissions/{committed.json()['id']}/",
        secure=True,
    )
    assert detail.status_code == 200 and detail.json()["manifest"] == body["manifest"]
    retry = write(client, url(assignment, work), body)
    assert retry.status_code == 200 and retry.json() == committed.json()

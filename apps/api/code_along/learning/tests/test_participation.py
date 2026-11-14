import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import pytest
from allauth.account.models import EmailAddress
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.db import close_old_connections
from django.test import Client
from django.utils import timezone
from rest_framework.exceptions import APIException

from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.events.models import OutboxEvent
from code_along.learning import participation_services as participation
from code_along.learning import team_services as teams
from code_along.learning import work_services as works
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentWork,
    AssignmentWorkMember,
)
from code_along.learning.tests.test_assignments import publish, ready_assignment, write
from code_along.projects import services as projects
from code_along.projects.frozen_projects import create_from_manifest
from code_along.projects.models import (
    CollaborationDocument,
    Project,
    ProjectAccess,
    ProjectFile,
)
from code_along.projects.revision_services import revision_manifest
from code_along.projects.tests.test_history import create_revision
from code_along.workspaces import invitations
from code_along.workspaces import services as workspace_services
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def reviewed_catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def prepared(
    mode: str = "individual", *, size: int = 6
) -> tuple[Project, Client, Assignment]:
    source, teacher, assignment = ready_assignment()
    if mode == "team":
        response = write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/draft/",
            {
                "expected_revision": assignment.revision,
                "submission_mode": "team",
                "max_team_size": size,
            },
            method="patch",
        )
        assert response.status_code == 200, response.content
        assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    return source, teacher, assignment


def learner(source: Project, name: str) -> tuple[User, Client]:
    user = person(name)
    WorkspaceMembership.objects.create(
        workspace=source.workspace, user=user, role="learner"
    )
    return user, signed_in(user)


def enroll(
    teacher: Client, assignment: Assignment, user: User, client: Client
) -> AssignmentParticipation:
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/participations/",
        {"recipient_id": str(user.id)},
    )
    assert response.status_code == 201, response.content
    assert (
        write(
            client,
            f"/api/v1/assignments/{assignment.id}/participation/accept/",
            {"expected_revision": response.json()["revision"]},
        ).status_code
        == 200
    )
    return AssignmentParticipation.objects.get(assignment=assignment, user=user)


def ready_team(
    teacher: Client, assignment: Assignment, people: list[tuple[User, Client]]
) -> AssignmentTeam:
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/teams/",
        {"name": "Learning together"},
    )
    assert response.status_code == 201, response.content
    team = AssignmentTeam.objects.get(id=response.json()["id"])
    for user, client in people:
        record = AssignmentParticipation.objects.filter(
            assignment=assignment, user=user
        ).first() or enroll(teacher, assignment, user, client)
        response = write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/teams/{team.id}/members/",
            {
                "participation_id": str(record.id),
                "expected_team_revision": team.revision,
                "expected_participation_revision": record.revision,
            },
        )
        assert response.status_code == 200, response.content
        team.refresh_from_db()
    approve_and_consent(teacher, assignment, team, people)
    return team


def approve_and_consent(
    teacher: Client,
    assignment: Assignment,
    team: AssignmentTeam,
    people: list[tuple[User, Client]],
) -> None:
    team.refresh_from_db()
    response = write(
        teacher,
        f"/api/v1/assignments/{assignment.id}/teams/{team.id}/approval/",
        {"expected_revision": team.revision, "roster_revision": team.roster_revision},
    )
    assert response.status_code == 200, response.content
    for user, client in people:
        record = AssignmentParticipation.objects.get(assignment=assignment, user=user)
        response = write(
            client,
            f"/api/v1/assignments/{assignment.id}/participation/team-consent/",
            {
                "expected_revision": record.revision,
                "team_id": str(team.id),
                "roster_revision": team.roster_revision,
            },
        )
        assert response.status_code == 200, response.content
    team.refresh_from_db()
    assert teams.consent_ready(team)


def work_body(assignment: Assignment, user: User) -> dict[str, Any]:
    record = AssignmentParticipation.objects.get(assignment=assignment, user=user)
    version = assignment.current_version
    assert version is not None
    return {
        "client_request_id": str(uuid.uuid4()),
        "assignment_version_id": str(version.id),
        "expected_participation_revision": record.revision,
        "expected_team_roster_revision": record.team.roster_revision
        if version.submission_mode == "team" and record.team
        else None,
        "project_name": "My frozen-starter work",
        "sharing": "approved_team_editors"
        if version.submission_mode == "team"
        else "private",
    }


def test_only_exact_recipient_accepts_with_real_csrf_and_open_offer() -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "recipient")
    other, stranger = learner(source, "other-recipient")
    base = f"/api/v1/assignments/{assignment.id}"
    response = write(teacher, f"{base}/participations/", {"recipient_id": str(user.id)})
    assert response.status_code == 201
    assert (
        write(
            teacher, f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 404
    )
    assert (
        write(
            stranger, f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 404
    )
    assert stranger.get(f"{base}/participations/", secure=True).status_code == 403
    real = Client(enforce_csrf_checks=True)
    real.force_login(user)
    assert (
        write(
            real, f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 403
    )
    token = real.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    for origin, expected in [
        ("https://foreign.example", 403),
        ("https://testserver", 200),
    ]:
        result = real.post(
            f"{base}/participation/accept/",
            {"expected_revision": 1},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN=origin,
        )
        assert result.status_code == expected, result.content
    assert (
        write(
            client, f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 200
    )
    assert ProjectAccess.objects.filter(user__in=[user, other]).count() == 0
    payload = client.get(f"{base}/participation/", secure=True).json()
    assert payload["state"] == "accepted" and payload["can_withdraw"]
    assert set(payload["user"]) == {"id", "display_name"}
    assert "@" not in str(payload)


def test_expiry_terminal_retry_and_explicit_reinvitation_cas_never_restore_old_consent() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "expires")
    base = f"/api/v1/assignments/{assignment.id}"
    assert (
        write(
            teacher, f"{base}/participations/", {"recipient_id": str(user.id)}
        ).status_code
        == 201
    )
    record = AssignmentParticipation.objects.get(user=user)
    AssignmentParticipation.objects.filter(id=record.id).update(
        invited_at=timezone.now() - timedelta(days=9),
        invite_expires_at=timezone.now() - timedelta(days=2),
    )
    assert (
        client.get(f"{base}/participation/", secure=True).json()["effective_state"]
        == "expired"
    )
    assert (
        write(
            client, f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 409
    )
    assert (
        write(
            teacher, f"{base}/participations/", {"recipient_id": str(user.id)}
        ).status_code
        == 409
    )
    assert (
        write(
            teacher,
            f"{base}/participations/",
            {"recipient_id": str(user.id), "expected_revision": 1},
        ).status_code
        == 200
    )
    record.refresh_from_db()
    assert (
        record.id == AssignmentParticipation.objects.get(user=user).id
        and record.revision == 2
    )
    assert (
        write(
            client, f"{base}/participation/accept/", {"expected_revision": 2}
        ).status_code
        == 200
    )
    assert (
        write(
            client, f"{base}/participation/withdraw/", {"expected_revision": 3}
        ).status_code
        == 200
    )
    assert (
        write(
            client, f"{base}/participation/withdraw/", {"expected_revision": 3}
        ).status_code
        == 200
    )
    assert (
        write(
            client, f"{base}/participation/accept/", {"expected_revision": 4}
        ).status_code
        == 409
    )
    assert (
        write(
            teacher,
            f"{base}/participations/",
            {"recipient_id": str(user.id), "expected_revision": 4},
        ).status_code
        == 200
    )
    record.refresh_from_db()
    assert (
        record.state == "invited"
        and record.accepted_at is None
        and record.team_id is None
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("expected_revision", True),
        ("expected_revision", 1.0),
        ("expected_revision", "1"),
        ("user_id", "forged"),
        ("state", "accepted"),
        ("participants", []),
    ],
)
def test_participation_rejects_forged_and_noninteger_fields(
    field: str, value: Any
) -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "strict")
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/participations/",
            {"recipient_id": str(user.id)},
        ).status_code
        == 201
    )
    assert (
        write(
            client,
            f"/api/v1/assignments/{assignment.id}/participation/accept/",
            {"expected_revision": 1, field: value},
        ).status_code
        == 400
    )
    assert AssignmentParticipation.objects.get(user=user).state == "invited"


def test_individual_work_copies_exact_published_starter_with_fresh_private_ids_and_no_capture() -> (
    None
):
    source, teacher, assignment = prepared()
    projects.add_file(
        source.owner,
        source.id,
        source.metadata_version,
        "Z_helpers.py",
        "# separate module\r\n",
    )
    source.refresh_from_db()
    second_revision = create_revision(source, teacher)
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/draft/",
            {
                "expected_revision": assignment.revision,
                "starter_revision_id": str(second_revision.id),
            },
            method="patch",
        ).status_code
        == 200
    )
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    user, client = learner(source, "individual")
    enroll(teacher, assignment, user, client)
    version = assignment.current_version
    assert version is not None
    frozen = revision_manifest(version.starter_revision)
    base = f"/api/v1/assignments/{assignment.id}"
    body = work_body(assignment, user)
    with patch(
        "code_along.projects.revision_services.post_control",
        side_effect=AssertionError("No live capture"),
    ):
        response = write(client, f"{base}/works/", body)
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    project = work.project
    assert (
        project.owner == user
        and project.id != source.id
        and project.runtime_profile_id == version.runtime_profile_id
    )
    copied = sorted(
        project.files.select_related("document"), key=lambda file: file.path
    )
    assert [
        (file.path, file.initial_source, file.initial_sha256) for file in copied
    ] == [(file["path"], file["source"], file["sha256"]) for file in frozen["files"]]
    assert all(
        str(file.id) not in {entry["file_id"] for entry in frozen["files"]}
        and str(file.document.id)
        not in {entry["document_id"] for entry in frozen["files"]}
        and file.generation == 1
        for file in copied
    )
    assert len(copied) == 2
    assert project.entrypoint_file.path == source.entrypoint_file.path
    assert (
        project.access_grants.count() == 0
        and work.members.get().source_role_at_creation == "owner"
    )
    assert client.get(f"/api/v1/projects/{source.id}/", secure=True).status_code == 404
    teacher_view = teacher.get(f"{base}/works/{work.id}/", secure=True).json()
    assert teacher_view["project"] is None and not teacher_view["can_continue"]
    assert str(project.id) not in str(teacher_view) and project.name not in str(
        teacher_view
    )
    assert write(client, f"{base}/works/", body).json()["id"] == str(work.id)
    changed = {**body, "project_name": "Changed nonce payload"}
    assert write(client, f"{base}/works/", changed).status_code == 409
    assert (
        write(
            client, f"{base}/works/", {**body, "client_request_id": str(uuid.uuid4())}
        ).json()["code"]
        == "work_already_exists"
    )


def test_team_work_requires_exact_approved_consent_and_explicit_new_project_sharing() -> (
    None
):
    source, teacher, assignment = prepared("team")
    first = learner(source, "team-first")
    second = learner(source, "team-second")
    mentor, observer = learner(source, "source-mentor")
    projects.set_grant(source.owner, source.id, mentor.id, "viewer")
    team = ready_team(teacher, assignment, [first, second])
    base = f"/api/v1/assignments/{assignment.id}"
    assert ProjectAccess.objects.filter(project=source, user=mentor).exists()
    before_grants = set(ProjectAccess.objects.values_list("id", flat=True))
    body = work_body(assignment, first[0])
    replacements: list[dict[str, Any]] = [
        {"sharing": "private"},
        {"expected_team_roster_revision": team.roster_revision - 1},
        {"participants": [str(mentor.id)]},
        {"owner_id": str(mentor.id)},
    ]
    for replacement in replacements:
        assert write(
            first[1], f"{base}/works/", {**body, **replacement}
        ).status_code in {400, 409}
    assert write(observer, f"{base}/works/", body).status_code == 404
    response = write(first[1], f"{base}/works/", body)
    assert response.status_code == 201, response.content
    work = AssignmentWork.objects.get(id=response.json()["id"])
    assert work.project.owner_id == first[0].id
    assert list(work.project.access_grants.values_list("user_id", "role")) == [
        (second[0].id, "editor")
    ]
    assert (
        set(
            ProjectAccess.objects.exclude(project=work.project).values_list(
                "id", flat=True
            )
        )
        == before_grants
    )
    assert set(work.members.values_list("user_id", "source_role_at_creation")) == {
        (first[0].id, "owner"),
        (second[0].id, "editor"),
    }
    assert not work.members.filter(user=mentor).exists()
    assert observer.get(f"{base}/works/{work.id}/", secure=True).status_code == 404
    assert observer.get(f"{base}/works/?mine=false", secure=True).status_code == 403
    assert (
        second[1].get(f"{base}/works/{work.id}/", secure=True).json()["project"]["role"]
        == "editor"
    )


def test_withdrawal_retires_old_work_without_revoking_source_and_successor_is_fresh_private_to_new_roster() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"departure-{index}") for index in range(3)]
    team = ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    created = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    assert created.status_code == 201
    old = AssignmentWork.objects.get(id=created.json()["id"])
    old_grants = set(old.project.access_grants.values_list("user_id", "role"))
    record = AssignmentParticipation.objects.get(
        assignment=assignment, user=people[0][0]
    )
    assert (
        write(
            people[0][1],
            f"{base}/participation/withdraw/",
            {"expected_revision": record.revision},
        ).status_code
        == 200
    )
    old.refresh_from_db()
    assert old.state == "retired" and old.retired_reason == "roster_changed"
    assert (
        old.project.owner_id == people[0][0].id
        and set(old.project.access_grants.values_list("user_id", "role")) == old_grants
    )
    assert (
        people[0][1]
        .get(f"{base}/works/{old.id}/", secure=True)
        .json()["project"]["role"]
        == "owner"
    )
    approve_and_consent(teacher, assignment, team, people[1:])
    response = write(
        people[1][1], f"{base}/works/", work_body(assignment, people[1][0])
    )
    assert response.status_code == 201, response.content
    new = AssignmentWork.objects.get(id=response.json()["id"])
    assert new.project_id != old.project_id and new.project.owner_id == people[1][0].id
    assert set(new.members.values_list("user_id", flat=True)) == {
        user.id for user, _ in people[1:]
    }
    assert people[0][1].get(f"{base}/works/{new.id}/", secure=True).status_code == 404
    assert (
        people[0][1].get(f"/api/v1/projects/{new.project_id}/", secure=True).status_code
        == 404
    )
    assert (
        people[0][1]
        .get(f"{base}/works/?include_retired=true", secure=True)
        .json()["count"]
        == 1
    )


def test_new_roster_member_has_no_old_work_projection_or_automatic_source_access() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"roster-{index}") for index in range(3)]
    team = ready_team(teacher, assignment, people[:2])
    base = f"/api/v1/assignments/{assignment.id}"
    created = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    old = AssignmentWork.objects.get(id=created.json()["id"])
    record = enroll(teacher, assignment, *people[2])
    assert (
        write(
            teacher,
            f"{base}/teams/{team.id}/members/",
            {
                "participation_id": str(record.id),
                "expected_team_revision": team.revision,
                "expected_participation_revision": record.revision,
            },
        ).status_code
        == 200
    )
    assert people[2][1].get(f"{base}/works/{old.id}/", secure=True).status_code == 404
    assert (
        people[2][1].get(f"/api/v1/projects/{old.project_id}/", secure=True).status_code
        == 404
    )
    assert not ProjectAccess.objects.filter(
        project_id=old.project_id, user=people[2][0]
    ).exists()


def test_membership_remove_then_normal_rejoin_without_learning_read_cannot_revive_consent() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"rejoin-{index}") for index in range(2)]
    team = ready_team(teacher, assignment, people)
    created = write(
        people[0][1],
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, people[0][0]),
    )
    work = AssignmentWork.objects.get(id=created.json()["id"])
    workspace_services.update_member(
        source.owner, source.workspace_id, people[1][0].id, remove=True
    )
    _, token = invitations.create_invitation(
        source.owner, source.workspace_id, people[1][0].email, "learner", 24
    )
    invitations.accept_invitation(people[1][0], token)
    # No learning request or selector occurs between the normal remove/rejoin commands.
    record = AssignmentParticipation.objects.get(
        assignment=assignment, user=people[1][0]
    )
    team.refresh_from_db()
    work.refresh_from_db()
    assert (
        record.state == "revoked"
        and record.team_id is None
        and record.team_consent_revision is None
    )
    assert (
        work.state == "retired"
        and team.approved_roster_revision is None
        and not teams.consent_ready(team)
    )
    assert not ProjectAccess.objects.filter(
        project=work.project, user=people[1][0]
    ).exists()
    assert (
        write(
            people[1][1],
            f"/api/v1/assignments/{assignment.id}/participation/accept/",
            {"expected_revision": record.revision},
        ).status_code
        == 409
    )


def test_failed_owned_project_removal_and_unrelated_role_or_workspace_changes_preserve_learning() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"guard-{index}") for index in range(2)]
    team = ready_team(teacher, assignment, people)
    created = write(
        people[0][1],
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, people[0][0]),
    )
    work = AssignmentWork.objects.get(id=created.json()["id"])
    before = list(
        AssignmentParticipation.objects.filter(assignment=assignment).values(
            "id", "revision", "state", "team_id", "team_consent_revision"
        )
    )
    with pytest.raises(APIException):
        workspace_services.update_member(
            source.owner, source.workspace_id, people[0][0].id, remove=True
        )
    workspace_services.update_workspace(
        source.owner, source.workspace_id, name="Unrelated rename"
    )
    workspace_services.update_member(
        source.owner, source.workspace_id, people[1][0].id, role="instructor"
    )
    assert (
        list(
            AssignmentParticipation.objects.filter(assignment=assignment).values(
                "id", "revision", "state", "team_id", "team_consent_revision"
            )
        )
        == before
    )
    team.refresh_from_db()
    work.refresh_from_db()
    assert teams.consent_ready(team) and work.state == "active"


def test_pinned_a_continues_after_b_without_policy_or_consent_retargeting() -> None:
    source, teacher, assignment = prepared("team", size=3)
    people = [learner(source, f"version-{index}") for index in range(3)]
    team = ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    body_a = work_body(assignment, people[0][0])
    created = write(people[0][1], f"{base}/works/", body_a)
    old = AssignmentWork.objects.get(id=created.json()["id"])
    version_a = old.assignment_version
    roster_before = list(
        team.participations.values("id", "revision", "team_consent_revision")
    )
    response = write(
        teacher,
        f"{base}/draft/",
        {
            "expected_revision": assignment.revision,
            "instructions": "New B instructions",
            "submission_mode": "individual",
            "max_team_size": 1,
            "public_checks_source": "assert True # B\n",
            "due_at": (timezone.now() + timedelta(days=3)).isoformat(),
        },
        method="patch",
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    old.refresh_from_db()
    assert old.state == "active" and old.assignment_version_id == version_a.id
    assert (
        list(team.participations.values("id", "revision", "team_consent_revision"))
        == roster_before
    )
    assert teams.consent_ready(team)
    assert (
        people[0][1].get(f"{base}/works/{old.id}/", secure=True).json()["can_continue"]
    )
    for version, eligible in [(version_a, True), (assignment.current_version, False)]:
        assert version is not None
        detail = (
            people[0][1]
            .get(
                f"{base}/teams/{team.id}/?assignment_version_id={version.id}",
                secure=True,
            )
            .json()
        )
        assert (
            detail["consent_ready"]
            and detail["version_eligibility"]["eligible"] is eligible
        )
    assert write(people[0][1], f"{base}/works/", body_a).status_code == 200
    assert (
        write(
            people[0][1],
            f"{base}/works/",
            {**body_a, "client_request_id": str(uuid.uuid4())},
        ).json()["code"]
        == "version_changed"
    )
    new = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    assert new.status_code == 201
    assert new.json()["project"]["id"] != str(old.project_id)
    old.refresh_from_db()
    assert old.state == "active"


def test_original_retry_after_source_access_revocation_redacts_project_without_regranting() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"retry-{index}") for index in range(2)]
    ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    body = work_body(assignment, people[0][0])
    created = write(people[0][1], f"{base}/works/", body)
    work = AssignmentWork.objects.get(id=created.json()["id"])
    projects.transfer_project(
        people[0][0], work.project_id, people[1][0].id, work.project.metadata_version
    )
    projects.revoke_grant(people[1][0], work.project_id, people[0][0].id)
    with patch.object(works, "MAX_WORK", 0):
        response = write(people[0][1], f"{base}/works/", body)
    assert response.status_code == 200 and response.json()["id"] == str(work.id)
    assert response.json()["project"] is None and not response.json()["can_continue"]
    assert not ProjectAccess.objects.filter(
        project_id=work.project_id, user=people[0][0]
    ).exists()


def test_old_accepted_consent_does_not_expire_and_changed_roster_refreshes_only_offers() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"expiry-{index}") for index in range(3)]
    team = ready_team(teacher, assignment, people[:2])
    AssignmentParticipation.objects.filter(assignment=assignment).update(
        invited_at=timezone.now() - timedelta(days=12),
        invite_expires_at=timezone.now() - timedelta(days=5),
        team_offer_expires_at=timezone.now() - timedelta(days=2),
    )
    assert teams.consent_ready(team)
    response = write(
        people[0][1],
        f"/api/v1/assignments/{assignment.id}/works/",
        work_body(assignment, people[0][0]),
    )
    assert response.status_code == 201
    record = enroll(teacher, assignment, *people[2])
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/teams/{team.id}/members/",
            {
                "participation_id": str(record.id),
                "expected_team_revision": team.revision,
                "expected_participation_revision": record.revision,
            },
        ).status_code
        == 200
    )
    team.refresh_from_db()
    for member in team.participations.all():
        assert (
            member.team_offer_expires_at is not None
            and member.team_offer_expires_at > timezone.now()
        )
        assert member.team_consent_revision is None
    assert not teams.consent_ready(team)
    approve_and_consent(teacher, assignment, team, people)


def test_final_logout_after_fresh_project_and_grants_rolls_back_every_domain_record() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"logout-{index}") for index in range(2)]
    ready_team(teacher, assignment, people)
    models: list[Any] = [
        Project,
        ProjectFile,
        CollaborationDocument,
        ProjectAccess,
        AssignmentWork,
        AssignmentWorkMember,
        OutboxEvent,
    ]
    before = [model.objects.count() for model in models]
    build = create_from_manifest
    key = people[0][1].session.session_key

    def logout_after_build(*args: Any, **kwargs: Any) -> Project:
        project = build(*args, **kwargs)
        Session.objects.filter(session_key=key).delete()
        return project

    with patch.object(works, "create_from_manifest", side_effect=logout_after_build):
        response = write(
            people[0][1],
            f"/api/v1/assignments/{assignment.id}/works/",
            work_body(assignment, people[0][0]),
        )
    assert response.status_code == 403
    assert [model.objects.count() for model in models] == before


def test_snapshot_failure_rolls_back_project_grants_work_and_outbox() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"rollback-{index}") for index in range(2)]
    ready_team(teacher, assignment, people)
    models: list[Any] = [
        Project,
        ProjectFile,
        CollaborationDocument,
        ProjectAccess,
        AssignmentWork,
        AssignmentWorkMember,
        OutboxEvent,
    ]
    before = [model.objects.count() for model in models]
    with (
        patch.object(
            AssignmentWorkMember.objects,
            "bulk_create",
            side_effect=RuntimeError("injected snapshot failure"),
        ),
        pytest.raises(RuntimeError, match="injected snapshot"),
    ):
        write(
            people[0][1],
            f"/api/v1/assignments/{assignment.id}/works/",
            work_body(assignment, people[0][0]),
        )
    assert [model.objects.count() for model in models] == before


def test_permanent_capacity_counts_terminal_records_and_does_not_advertise_retry_after() -> (
    None
):
    source, teacher, assignment = prepared()
    people = [learner(source, f"capacity-{index}") for index in range(2)]
    base = f"/api/v1/assignments/{assignment.id}"
    enroll(teacher, assignment, *people[0])
    record = AssignmentParticipation.objects.get(user=people[0][0])
    assert (
        write(
            people[0][1],
            f"{base}/participation/withdraw/",
            {"expected_revision": record.revision},
        ).status_code
        == 200
    )
    with patch.object(participation, "MAX_PARTICIPATIONS", 1):
        response = write(
            teacher, f"{base}/participations/", {"recipient_id": str(people[1][0].id)}
        )
    assert (
        response.status_code == 409
        and response.json()["code"] == "participation_capacity"
        and "Retry-After" not in response
    )
    created = write(teacher, f"{base}/teams/", {"name": "Retained team"})
    assert created.status_code == 201
    assert (
        write(
            teacher,
            f"{base}/teams/{created.json()['id']}/",
            {"expected_revision": 1, "archived": True},
            method="patch",
        ).status_code
        == 200
    )
    with patch.object(teams, "MAX_TEAMS", 1):
        response = write(
            teacher, f"{base}/teams/", {"name": "Capacity does not prune history"}
        )
    assert (
        response.status_code == 409
        and response.json()["code"] == "team_capacity"
        and "Retry-After" not in response
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_same_nonce_creates_one_project_and_safe_original_result() -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "concurrent-work")
    enroll(teacher, assignment, user, client)
    body = work_body(assignment, user)
    body["assignment_version_id"] = uuid.UUID(body["assignment_version_id"])
    body["client_request_id"] = uuid.UUID(body["client_request_id"])
    key = client.session.session_key

    def create() -> tuple[uuid.UUID, bool]:
        close_old_connections()
        try:
            work, created = works.create_work(user, key, assignment.id, **body)
            return work.id, created
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: create(), range(2)))
    assert results[0][0] == results[1][0] and sorted(
        created for _, created in results
    ) == [False, True]
    assert (
        AssignmentWork.objects.count() == 1
        and AssignmentWorkMember.objects.count() == 1
        and Project.objects.count() == 2
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_withdrawal_and_creation_never_leave_an_active_ineligible_work() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "withdraw-race")
    record = enroll(teacher, assignment, user, client)
    body = work_body(assignment, user)
    body["assignment_version_id"] = uuid.UUID(body["assignment_version_id"])
    body["client_request_id"] = uuid.UUID(body["client_request_id"])
    key = client.session.session_key

    def command(action: str) -> int:
        close_old_connections()
        try:
            if action == "create":
                works.create_work(user, key, assignment.id, **body)
            else:
                participation.transition_participation(
                    user,
                    key,
                    assignment.id,
                    action="withdraw",
                    expected_revision=record.revision,
                )
            return 200
        except APIException as error:
            return error.status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(command, ["create", "withdraw"]))
    assert results[1] == 200 and results[0] in {200, 409}
    assert AssignmentParticipation.objects.get(id=record.id).state == "withdrawn"
    assert not AssignmentWork.objects.filter(state="active").exists()


def test_disabled_unverified_staff_and_foreign_members_have_no_participation_bypass() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "no-bypass")
    user.is_staff = user.is_superuser = True
    user.save(update_fields=["is_staff", "is_superuser"])
    assert (
        write(
            client, f"/api/v1/assignments/{assignment.id}/teams/", {"name": "Forbidden"}
        ).status_code
        == 403
    )
    EmailAddress.objects.filter(user=user).update(verified=False)
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/participations/",
            {"recipient_id": str(user.id)},
        ).status_code
        == 403
    )
    foreign = person("foreign-recipient")
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/participations/",
            {"recipient_id": str(foreign.id)},
        ).status_code
        == 403
    )
    assert (
        signed_in(foreign)
        .get(f"/api/v1/assignments/{assignment.id}/teams/", secure=True)
        .status_code
        == 404
    )


def test_cross_team_move_invalidates_both_exact_rosters_and_retains_both_old_projects() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"move-{index}") for index in range(4)]
    first = ready_team(teacher, assignment, people[:2])
    second = ready_team(teacher, assignment, people[2:])
    base = f"/api/v1/assignments/{assignment.id}"
    old = []
    for user, client in [people[0], people[2]]:
        result = write(client, f"{base}/works/", work_body(assignment, user))
        assert result.status_code == 201, result.content
        old.append(AssignmentWork.objects.get(id=result.json()["id"]))
    grants = set(
        ProjectAccess.objects.values_list("id", "project_id", "user_id", "role")
    )
    prior_roster = first.roster_revision
    mover = AssignmentParticipation.objects.get(
        assignment=assignment, user=people[1][0]
    )
    result = write(
        teacher,
        f"{base}/teams/{second.id}/members/",
        {
            "participation_id": str(mover.id),
            "expected_team_revision": second.revision,
            "expected_participation_revision": mover.revision,
        },
    )
    assert result.status_code == 200, result.content
    for team in [first, second]:
        team.refresh_from_db()
        assert team.approved_roster_revision is None and not teams.consent_ready(team)
        assert all(
            member.team_consent_revision is None for member in team.participations.all()
        )
    for work in old:
        work.refresh_from_db()
        assert work.state == "retired" and work.retired_reason == "roster_changed"
    assert (
        set(ProjectAccess.objects.values_list("id", "project_id", "user_id", "role"))
        == grants
    )
    remaining = AssignmentParticipation.objects.get(
        assignment=assignment, user=people[0][0]
    )
    assert (
        write(
            people[0][1],
            f"{base}/participation/team-consent/",
            {
                "expected_revision": remaining.revision,
                "team_id": str(first.id),
                "roster_revision": prior_roster,
            },
        ).status_code
        == 409
    )
    assert (
        people[1][1].get(f"{base}/works/{old[1].id}/", secure=True).status_code == 404
    )


def test_team_archive_restore_requires_new_consent_and_never_reactivates_old_work() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"archive-{index}") for index in range(2)]
    team = ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    body = work_body(assignment, people[0][0])
    created = write(people[0][1], f"{base}/works/", body)
    old = AssignmentWork.objects.get(id=created.json()["id"])
    assert (
        write(
            teacher,
            f"{base}/teams/{team.id}/",
            {"expected_revision": team.revision, "archived": True},
            method="patch",
        ).status_code
        == 200
    )
    team.refresh_from_db()
    assert (
        write(
            teacher,
            f"{base}/teams/{team.id}/",
            {"expected_revision": team.revision, "archived": False},
            method="patch",
        ).status_code
        == 200
    )
    team.refresh_from_db()
    old.refresh_from_db()
    assert old.state == "retired" and old.retired_reason == "team_archived"
    assert not teams.consent_ready(team)
    original = write(people[0][1], f"{base}/works/", body)
    assert original.status_code == 200 and original.json()["state"] == "retired"
    assert (
        write(
            people[0][1], f"{base}/works/", work_body(assignment, people[0][0])
        ).status_code
        == 409
    )
    approve_and_consent(teacher, assignment, team, people)
    fresh = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    assert fresh.status_code == 201 and fresh.json()["project"]["id"] != str(
        old.project_id
    )


def test_outside_subject_ownership_allows_only_explicit_fresh_starter_successor() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"owner-{index}") for index in range(2)]
    outsider, outside_client = learner(source, "outside-owner")
    ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    created = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    old = AssignmentWork.objects.get(id=created.json()["id"])
    projects.transfer_project(
        people[0][0], old.project_id, outsider.id, old.project.metadata_version
    )
    old.project.refresh_from_db()
    projects.add_file(
        outsider,
        old.project_id,
        old.project.metadata_version,
        "private_extra.py",
        "# never copied to successor\n",
    )
    grants = set(old.project.access_grants.values_list("id", "user_id", "role"))
    assert (
        not people[0][1]
        .get(f"{base}/works/{old.id}/", secure=True)
        .json()["can_continue"]
    )
    fresh = write(people[1][1], f"{base}/works/", work_body(assignment, people[1][0]))
    assert fresh.status_code == 201, fresh.content
    new = AssignmentWork.objects.get(id=fresh.json()["id"])
    old.refresh_from_db()
    assert old.state == "retired" and old.retired_reason == "project_unavailable"
    assert new.project_id != old.project_id and new.project.owner_id == people[1][0].id
    assert new.project.files.count() == 1 and old.project.files.count() == 2
    assert set(old.project.access_grants.values_list("id", "user_id", "role")) == grants
    assert (
        outside_client.get(
            f"/api/v1/projects/{new.project_id}/", secure=True
        ).status_code
        == 404
    )


def test_losing_one_source_grant_cannot_take_over_another_members_active_work() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"grant-{index}") for index in range(2)]
    ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    created = write(people[0][1], f"{base}/works/", work_body(assignment, people[0][0]))
    old = AssignmentWork.objects.get(id=created.json()["id"])
    projects.revoke_grant(people[0][0], old.project_id, people[1][0].id)
    count = Project.objects.count()
    denied = write(people[1][1], f"{base}/works/", work_body(assignment, people[1][0]))
    assert denied.status_code == 409 and denied.json()["code"] == "work_already_exists"
    old.refresh_from_db()
    assert (
        Project.objects.count() == count
        and old.state == "active"
        and old.project.owner_id == people[0][0].id
    )
    assert (
        people[1][1].get(f"{base}/works/{old.id}/", secure=True).json()["project"]
        is None
    )


def test_archived_assignment_allows_consent_reduction_but_not_new_acceptance_or_work() -> (
    None
):
    source, teacher, assignment = prepared()
    first = learner(source, "archive-accepted")
    second = learner(source, "archive-offered")
    record = enroll(teacher, assignment, *first)
    base = f"/api/v1/assignments/{assignment.id}"
    assert (
        write(
            teacher, f"{base}/participations/", {"recipient_id": str(second[0].id)}
        ).status_code
        == 201
    )
    assert (
        write(
            teacher,
            f"{base}/",
            {"expected_revision": assignment.revision, "archived": True},
            method="patch",
        ).status_code
        == 200
    )
    assert (
        write(
            second[1], f"{base}/participation/accept/", {"expected_revision": 1}
        ).status_code
        == 400
    )
    assert (
        write(first[1], f"{base}/works/", work_body(assignment, first[0])).status_code
        == 400
    )
    assert (
        write(
            first[1],
            f"{base}/participation/withdraw/",
            {"expected_revision": record.revision},
        ).status_code
        == 200
    )
    assert (
        write(
            second[1], f"{base}/participation/decline/", {"expected_revision": 1}
        ).status_code
        == 200
    )
    current = AssignmentParticipation.objects.get(id=record.id)
    assert (
        write(
            teacher,
            f"{base}/participations/{current.id}/revoke/",
            {"expected_revision": current.revision},
        ).status_code
        == 200
    )


def test_post_save_logout_during_acceptance_rolls_back_consent() -> None:
    source, teacher, assignment = prepared()
    user, client = learner(source, "accept-session")
    base = f"/api/v1/assignments/{assignment.id}"
    assert (
        write(
            teacher, f"{base}/participations/", {"recipient_id": str(user.id)}
        ).status_code
        == 201
    )
    key = client.session.session_key
    save = AssignmentParticipation.save

    def logout_after_accept(
        record: AssignmentParticipation, *args: Any, **kwargs: Any
    ) -> None:
        save(record, *args, **kwargs)
        if record.user_id == user.id and record.state == "accepted":
            Session.objects.filter(session_key=key).delete()

    with patch.object(AssignmentParticipation, "save", new=logout_after_accept):
        response = write(
            client, f"{base}/participation/accept/", {"expected_revision": 1}
        )
    assert response.status_code == 403
    record = AssignmentParticipation.objects.get(user=user)
    assert (
        record.state == "invited"
        and record.revision == 1
        and record.accepted_at is None
    )


def test_post_save_logout_during_approval_rolls_back_teacher_decision() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"approval-session-{index}") for index in range(2)]
    team = ready_team(teacher, assignment, people)
    # An explicit new offer creates a fresh unapproved roster.
    record = AssignmentParticipation.objects.get(user=people[0][0])
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/teams/{team.id}/members/",
            {
                "participation_id": str(record.id),
                "expected_team_revision": team.revision,
                "expected_participation_revision": record.revision,
            },
        ).status_code
        == 200
    )
    team.refresh_from_db()
    before = team.revision
    key = teacher.session.session_key
    save = AssignmentTeam.save

    def logout_after_approval(
        record: AssignmentTeam, *args: Any, **kwargs: Any
    ) -> None:
        save(record, *args, **kwargs)
        if record.id == team.id and record.approved_roster_revision is not None:
            Session.objects.filter(session_key=key).delete()

    with patch.object(AssignmentTeam, "save", new=logout_after_approval):
        result = write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/teams/{team.id}/approval/",
            {
                "expected_revision": team.revision,
                "roster_revision": team.roster_revision,
            },
        )
    assert result.status_code == 403
    team.refresh_from_db()
    assert team.revision == before and team.approved_roster_revision is None


def test_final_recipient_disable_during_offer_preparation_leaves_no_invitation() -> (
    None
):
    source, teacher, assignment = prepared()
    user, _ = learner(source, "disable-offer")
    create = AssignmentParticipation.objects.create

    def disable_after_create(*args: Any, **kwargs: Any) -> AssignmentParticipation:
        result = create(*args, **kwargs)
        User.objects.filter(id=user.id).update(is_active=False)
        return result

    with patch.object(
        AssignmentParticipation.objects, "create", side_effect=disable_after_create
    ):
        response = write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/participations/",
            {"recipient_id": str(user.id)},
        )
    assert (
        response.status_code == 409
        and not AssignmentParticipation.objects.filter(user=user).exists()
    )


@pytest.mark.django_db(transaction=True)
def test_concurrent_final_team_slot_never_admits_a_seventh_member() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"team-limit-{index}") for index in range(7)]
    team = ready_team(teacher, assignment, people[:5])
    extra = [enroll(teacher, assignment, *person) for person in people[5:]]
    key = teacher.session.session_key

    def add(record: AssignmentParticipation) -> int:
        close_old_connections()
        try:
            teams.offer_team_member(
                source.owner,
                key,
                assignment.id,
                team.id,
                participation_id=record.id,
                expected_team_revision=team.revision,
                expected_participation_revision=record.revision,
            )
            return 200
        except APIException as error:
            return error.status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(add, extra))
    assert sorted(results) == [200, 409] and team.participations.count() == 6


def test_retired_work_capacity_is_permanent_but_original_retry_is_still_a_read() -> (
    None
):
    source, teacher, assignment = prepared()
    user, client = learner(source, "work-capacity")
    record = enroll(teacher, assignment, user, client)
    base = f"/api/v1/assignments/{assignment.id}"
    body = work_body(assignment, user)
    created = write(client, f"{base}/works/", body)
    assert created.status_code == 201
    assert (
        write(
            client,
            f"{base}/participation/withdraw/",
            {"expected_revision": record.revision},
        ).status_code
        == 200
    )
    current = AssignmentParticipation.objects.get(id=record.id)
    assert (
        write(
            teacher,
            f"{base}/participations/",
            {"recipient_id": str(user.id), "expected_revision": current.revision},
        ).status_code
        == 200
    )
    current.refresh_from_db()
    assert (
        write(
            client,
            f"{base}/participation/accept/",
            {"expected_revision": current.revision},
        ).status_code
        == 200
    )
    with patch.object(works, "MAX_WORK", 1):
        denied = write(client, f"{base}/works/", work_body(assignment, user))
        original = write(client, f"{base}/works/", body)
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "assignment_work_capacity"
        and "Retry-After" not in denied
    )
    assert (
        original.status_code == 200
        and original.json()["id"] == created.json()["id"]
        and original.json()["state"] == "retired"
    )


def test_teacher_approval_never_replaces_each_recipients_exact_roster_consent() -> None:
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"independent-consent-{index}") for index in range(2)]
    team = ready_team(teacher, assignment, people)
    base = f"/api/v1/assignments/{assignment.id}"
    record = AssignmentParticipation.objects.get(user=people[0][0])
    assert (
        write(
            teacher,
            f"{base}/teams/{team.id}/members/",
            {
                "participation_id": str(record.id),
                "expected_team_revision": team.revision,
                "expected_participation_revision": record.revision,
            },
        ).status_code
        == 200
    )
    team.refresh_from_db()
    assert (
        write(
            teacher,
            f"{base}/teams/{team.id}/approval/",
            {
                "expected_revision": team.revision,
                "roster_revision": team.roster_revision,
            },
        ).status_code
        == 200
    )
    assert (
        write(
            people[0][1], f"{base}/works/", work_body(assignment, people[0][0])
        ).status_code
        == 409
    )
    for index, (user, client) in enumerate(people):
        record = AssignmentParticipation.objects.get(user=user)
        assert (
            write(
                client,
                f"{base}/participation/team-consent/",
                {
                    "expected_revision": record.revision,
                    "team_id": str(team.id),
                    "roster_revision": team.roster_revision,
                },
            ).status_code
            == 200
        )
        if index == 0:
            assert (
                write(client, f"{base}/works/", work_body(assignment, user)).status_code
                == 409
            )
    assert (
        write(
            people[0][1], f"{base}/works/", work_body(assignment, people[0][0])
        ).status_code
        == 201
    )


@pytest.mark.django_db(transaction=True)
def test_team_withdrawal_racing_work_creation_cannot_share_to_a_changed_roster() -> (
    None
):
    source, teacher, assignment = prepared("team")
    people = [learner(source, f"team-withdraw-race-{index}") for index in range(2)]
    ready_team(teacher, assignment, people)
    body = work_body(assignment, people[0][0])
    body["assignment_version_id"] = uuid.UUID(body["assignment_version_id"])
    body["client_request_id"] = uuid.UUID(body["client_request_id"])
    departing = AssignmentParticipation.objects.get(user=people[1][0])
    keys = [client.session.session_key for _, client in people]

    def command(action: str) -> int:
        close_old_connections()
        try:
            if action == "create":
                works.create_work(people[0][0], keys[0], assignment.id, **body)
            else:
                participation.transition_participation(
                    people[1][0],
                    keys[1],
                    assignment.id,
                    action="withdraw",
                    expected_revision=departing.revision,
                )
            return 200
        except APIException as error:
            return error.status_code
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(command, ["create", "withdraw"]))
    assert results[1] == 200 and results[0] in {200, 409}
    assert not AssignmentWork.objects.filter(state="active").exists()
    for work in AssignmentWork.objects.all():
        assert work.state == "retired" and work.retired_reason == "roster_changed"
        assert set(work.members.values_list("user_id", flat=True)) == {
            user.id for user, _ in people
        }


def test_deadline_passage_does_not_prevent_reading_or_practice_work() -> None:
    source, teacher, assignment = ready_assignment()
    due = timezone.now() + timedelta(hours=1)
    assert (
        write(
            teacher,
            f"/api/v1/assignments/{assignment.id}/draft/",
            {"expected_revision": assignment.revision, "due_at": due.isoformat()},
            method="patch",
        ).status_code
        == 200
    )
    assignment.refresh_from_db()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    user, client = learner(source, "after-deadline")
    enroll(teacher, assignment, user, client)
    with patch.object(timezone, "now", return_value=due + timedelta(hours=1)):
        response = write(
            client,
            f"/api/v1/assignments/{assignment.id}/works/",
            work_body(assignment, user),
        )
        assert response.status_code == 201 and response.json()["can_continue"]
        assert (
            client.get(f"/api/v1/assignments/{assignment.id}/", secure=True).status_code
            == 200
        )

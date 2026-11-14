"""Database boundaries for participation and immutable work access intent."""

import copy
import io
import uuid
from datetime import timedelta
from typing import Any

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.utils import timezone

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning.models import (
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentVersion,
    AssignmentWork,
    AssignmentWorkMember,
)
from code_along.learning.tests.test_assignments import (
    publish,
    ready_assignment,
    ready_assignment_unique,
)
from code_along.projects import services as projects
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def reviewed_catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def work_fixture() -> tuple[AssignmentVersion, AssignmentParticipation, AssignmentWork]:
    source, client, assignment = ready_assignment()
    assert publish(client, assignment).status_code == 201
    version = AssignmentVersion.objects.get(assignment=assignment)
    participant = AssignmentParticipation.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        user=source.owner,
        invited_by=source.owner,
        state="accepted",
        accepted_at=timezone.now(),
    )
    project = projects.create_project(source.owner, source.workspace_id, "Own work")
    work = AssignmentWork.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        assignment_version=version,
        created_by=source.owner,
        subject_kind="individual",
        participation=participant,
        project=project,
        client_request_id=uuid.uuid4(),
        request_sha256="a" * 64,
    )
    return version, participant, work


def immediate_constraints() -> None:
    with connection.cursor() as cursor:
        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_all_work_parent_pairs_are_deferred_database_foreign_keys() -> None:
    expected = {
        "team_assignment_workspace",
        "participation_assignment_workspace",
        "participation_workspace_member",
        "participation_team_assignment",
        "work_assignment_workspace",
        "work_version_assignment",
        "work_participation_assignment",
        "work_team_assignment",
        "work_project_workspace",
        "work_member_assignment",
        "work_member_participation_identity",
    }
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT conname,condeferrable,condeferred FROM pg_constraint "
            "WHERE connamespace='public'::regnamespace AND conname=ANY(%s)",
            [list(expected)],
        )
        rows = cursor.fetchall()
    assert {name for name, _, _ in rows} == expected
    assert all(deferrable and deferred for _, deferrable, deferred in rows)


def test_foreign_workspace_assignment_subject_and_snapshot_parents_are_rejected() -> (
    None
):
    version, participant, work = work_fixture()
    foreign_project, foreign_client, foreign_assignment = ready_assignment_unique()
    assert publish(foreign_client, foreign_assignment).status_code == 201
    foreign_version = AssignmentVersion.objects.get(assignment=foreign_assignment)
    foreign_participant = AssignmentParticipation.objects.create(
        assignment=foreign_assignment,
        workspace=foreign_assignment.workspace,
        user=foreign_project.owner,
        invited_by=foreign_project.owner,
        state="accepted",
        accepted_at=timezone.now(),
    )
    foreign_team = AssignmentTeam.objects.create(
        assignment=foreign_assignment,
        workspace=foreign_assignment.workspace,
        created_by=foreign_project.owner,
        name="Foreign team",
    )
    for participation_fields in (
        {"workspace_id": foreign_project.workspace_id},
        {"user_id": foreign_project.owner_id},
        {
            "team_id": foreign_team.id,
            "team_offer_expires_at": timezone.now() + timedelta(days=1),
        },
    ):
        participation_candidate = copy.copy(participant)
        participation_candidate.pk = uuid.uuid4()
        participation_candidate.user = person(
            f"participation_candidate-{uuid.uuid4().hex[:8]}"
        )
        WorkspaceMembership.objects.create(
            workspace=version.workspace,
            user=participation_candidate.user,
            role="learner",
        )
        for name, value in participation_fields.items():
            setattr(participation_candidate, name, value)
        with pytest.raises(IntegrityError), transaction.atomic():
            participation_candidate.save(force_insert=True)
            immediate_constraints()
    AssignmentWork.objects.filter(id=work.id).update(
        state="retired", retired_at=timezone.now(), retired_reason="project_unavailable"
    )
    for work_fields in (
        {"workspace_id": foreign_project.workspace_id},
        {"assignment_version_id": foreign_version.id},
        {"participation_id": foreign_participant.id},
        {
            "subject_kind": "team",
            "participation_id": None,
            "team_id": foreign_team.id,
            "team_roster_revision": 1,
        },
        {"project_id": foreign_project.id},
    ):
        work_candidate = copy.copy(work)
        work_candidate.pk, work_candidate.client_request_id = uuid.uuid4(), uuid.uuid4()
        work_candidate.project = projects.create_project(
            participant.user, version.workspace_id, "Candidate work"
        )
        for name, value in work_fields.items():
            setattr(work_candidate, name, value)
        with pytest.raises(IntegrityError), transaction.atomic():
            work_candidate.save(force_insert=True)
            immediate_constraints()
    # A work snapshot cannot borrow the identity from another participation.
    for snapshot_fields in (
        {"assignment_id": foreign_assignment.id},
        {"participation_id": foreign_participant.id},
        {"user_id": foreign_project.owner_id, "source_role_at_creation": "editor"},
    ):
        values: dict[str, Any] = {
            "work": work,
            "assignment": version.assignment,
            "participation": participant,
            "user": participant.user,
            "display_name": "Learner",
            "participation_revision": participant.revision,
            "source_role_at_creation": "owner",
        }
        values.update(snapshot_fields)
        # Avoid passing both FK object and its changed raw ID.
        for key in snapshot_fields:
            if key.endswith("_id"):
                values.pop(key[:-3], None)
        with pytest.raises(IntegrityError), transaction.atomic():
            AssignmentWorkMember.objects.create(**values)
            immediate_constraints()
    with pytest.raises(IntegrityError), transaction.atomic():
        AssignmentTeam.objects.create(
            assignment=version.assignment,
            workspace=foreign_assignment.workspace,
            created_by=participant.user,
            name="Wrong workspace",
        )
        immediate_constraints()


@pytest.mark.parametrize(
    "fields",
    [
        {"revision": 0},
        {"revision": 9007199254740992},
        {"state": "accepted", "accepted_at": None},
        {"state": "withdrawn", "ended_at": None},
        {"state": "invented"},
        {"team_consented_at": timezone.now(), "team_consent_revision": None},
        {"team_consent_revision": 1, "team_consented_at": None},
    ],
)
def test_participation_state_time_and_safe_revision_checks(
    fields: dict[str, Any],
) -> None:
    version, participant, _ = work_fixture()
    if any(name.startswith("team_") for name in fields):
        team = AssignmentTeam.objects.create(
            assignment=version.assignment,
            workspace=version.workspace,
            created_by=participant.user,
            name="Consent pairs",
        )
        AssignmentParticipation.objects.filter(id=participant.id).update(
            team=team, team_offer_expires_at=timezone.now() + timedelta(days=1)
        )
    with pytest.raises(IntegrityError), transaction.atomic():
        AssignmentParticipation.objects.filter(id=participant.id).update(**fields)


def test_nullable_approval_and_subject_pairs_cannot_pass_sql_unknown() -> None:
    version, participant, work = work_fixture()
    team = AssignmentTeam.objects.create(
        assignment=version.assignment,
        workspace=version.workspace,
        created_by=participant.user,
        name="Team",
    )
    for values in (
        {"approved_by": participant.user, "approved_at": timezone.now()},
        {"approved_roster_revision": 1},
        {
            "approved_roster_revision": 2,
            "approved_by": participant.user,
            "approved_at": timezone.now(),
        },
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            AssignmentTeam.objects.filter(id=team.id).update(**values)
    candidate = copy.copy(work)
    candidate.pk, candidate.client_request_id = uuid.uuid4(), uuid.uuid4()
    candidate.project = projects.create_project(
        participant.user, version.workspace_id, "Pair"
    )
    candidate.subject_kind, candidate.participation, candidate.team = "team", None, team
    candidate.team_roster_revision = None
    with pytest.raises(IntegrityError), transaction.atomic():
        candidate.save(force_insert=True)
    candidate = copy.copy(work)
    candidate.pk, candidate.client_request_id = uuid.uuid4(), uuid.uuid4()
    candidate.project = projects.create_project(
        participant.user, version.workspace_id, "Retirement pair"
    )
    candidate.state, candidate.retired_at, candidate.retired_reason = (
        "retired",
        timezone.now(),
        None,
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        candidate.save(force_insert=True)


def test_work_identity_and_retirement_and_member_snapshot_are_immutable() -> None:
    version, participant, work = work_fixture()
    member = AssignmentWorkMember.objects.create(
        work=work,
        assignment=version.assignment,
        participation=participant,
        user=participant.user,
        display_name="Learner",
        participation_revision=participant.revision,
        source_role_at_creation="owner",
    )
    for statement, identifier in (
        (
            "UPDATE public.learning_assignmentwork SET request_sha256=repeat('b',64) WHERE id=%s",
            work.id,
        ),
        (
            "UPDATE public.learning_assignmentwork SET created_at=now() WHERE id=%s",
            work.id,
        ),
        ("DELETE FROM public.learning_assignmentwork WHERE id=%s", work.id),
        (
            "UPDATE public.learning_assignmentworkmember SET display_name='Other' WHERE id=%s",
            member.id,
        ),
        ("DELETE FROM public.learning_assignmentworkmember WHERE id=%s", member.id),
    ):
        with (
            pytest.raises(IntegrityError),
            transaction.atomic(),
            connection.cursor() as cursor,
        ):
            cursor.execute(statement, [identifier])
    now = timezone.now()
    assert (
        AssignmentWork.objects.filter(id=work.id).update(
            state="retired", retired_at=now, retired_reason="participation_ended"
        )
        == 1
    )
    assert AssignmentWork.objects.filter(id=work.id).update(state="retired") == 1
    for fields in (
        {"state": "active", "retired_at": None, "retired_reason": None},
        {"retired_reason": "roster_changed"},
        {"retired_at": now + timedelta(seconds=1)},
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            AssignmentWork.objects.filter(id=work.id).update(**fields)
    assert AssignmentWorkMember.objects.get(id=member.id).display_name == "Learner"


def test_active_subject_and_actor_nonce_uniqueness_preserve_retired_work() -> None:
    version, participant, work = work_fixture()
    candidate = copy.copy(work)
    candidate.pk, candidate.client_request_id = uuid.uuid4(), uuid.uuid4()
    candidate.project = projects.create_project(
        participant.user, version.workspace_id, "Successor"
    )
    with pytest.raises(IntegrityError), transaction.atomic():
        candidate.save(force_insert=True)
    AssignmentWork.objects.filter(id=work.id).update(
        state="retired", retired_at=timezone.now(), retired_reason="project_unavailable"
    )
    candidate.client_request_id = work.client_request_id
    with pytest.raises(IntegrityError), transaction.atomic():
        candidate.save(force_insert=True)
    candidate.client_request_id = uuid.uuid4()
    candidate.save(force_insert=True)
    assert AssignmentWork.objects.filter(assignment=version.assignment).count() == 2
    assert AssignmentWork.objects.get(id=work.id).state == "retired"


def test_snapshot_creation_requires_exact_access_intent_and_at_most_six_members() -> (
    None
):
    version, owner_participation, work = work_fixture()
    # A separate team work record exercises the immutable access-intent boundary.
    team = AssignmentTeam.objects.create(
        assignment=version.assignment,
        workspace=version.workspace,
        created_by=owner_participation.user,
        name="Team",
    )
    team_work = AssignmentWork.objects.create(
        assignment=version.assignment,
        workspace=version.workspace,
        assignment_version=version,
        created_by=owner_participation.user,
        subject_kind="team",
        team=team,
        team_roster_revision=1,
        project=projects.create_project(
            owner_participation.user, version.workspace_id, "Team work"
        ),
        client_request_id=uuid.uuid4(),
        request_sha256="c" * 64,
    )
    base: dict[str, Any] = {
        "work": team_work,
        "assignment": version.assignment,
        "participation": owner_participation,
        "user": owner_participation.user,
        "display_name": "Owner",
        "participation_revision": 1,
        "consent_roster_revision": 1,
        "source_role_at_creation": "owner",
    }
    for fields in (
        {"source_role_at_creation": "editor"},
        {"consent_roster_revision": None},
        {"consent_roster_revision": 2},
    ):
        with pytest.raises(IntegrityError), transaction.atomic():
            AssignmentWorkMember.objects.create(**{**base, **fields})
    AssignmentWorkMember.objects.create(**base)
    for index in range(6):
        user = person(f"snapshot-{index}")
        WorkspaceMembership.objects.create(
            workspace=version.workspace, user=user, role="learner"
        )
        participation = AssignmentParticipation.objects.create(
            assignment=version.assignment,
            workspace=version.workspace,
            user=user,
            invited_by=owner_participation.user,
        )
        values = {
            **base,
            "user": user,
            "participation": participation,
            "display_name": user.display_name,
            "source_role_at_creation": "editor",
        }
        if index < 5:
            AssignmentWorkMember.objects.create(**values)
        else:
            with pytest.raises(IntegrityError), transaction.atomic():
                AssignmentWorkMember.objects.create(**values)
    assert team_work.members.count() == 6
    assert work.members.count() == 0


def test_participation_work_migrations_reverse_and_restore_integrity_without_drift() -> (
    None
):
    call_command("migrate", "learning", "0002", verbosity=0)
    call_command("migrate", verbosity=0)
    call_command("makemigrations", "--check", "--dry-run", stdout=io.StringIO())
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY(%s)",
            [
                [
                    "guarded_assignment_work",
                    "immutable_assignment_work_member",
                    "immutable_assignment_version",
                ]
            ],
        )
        assert {row[0] for row in cursor.fetchall()} == {
            "guarded_assignment_work",
            "immutable_assignment_work_member",
            "immutable_assignment_version",
        }

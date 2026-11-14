import uuid

from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import NotFound

from code_along.accounts.models import User

from .contracts import label
from .models import (
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentVersion,
)
from .participation_services import (
    MAX_TEAMS,
    OFFER_DURATION,
    active_verified,
    current_member,
    increment,
    invalidate_team,
    lock_learning,
    own_participation,
    require_revision,
)
from .policies import require_assignment_mutable
from .services import AssignmentCapacity, AssignmentConflict


def roster(team: AssignmentTeam) -> list[AssignmentParticipation]:
    return list(
        team.participations.filter(state="accepted")
        .select_related("user")
        .order_by("id")
    )


def consent_ready(
    team: AssignmentTeam, members: list[AssignmentParticipation] | None = None
) -> bool:
    members = roster(team) if members is None else members
    return (
        team.archived_at is None
        and 2 <= len(members) <= 6
        and team.approved_roster_revision == team.roster_revision
        and all(
            member.team_consent_revision == team.roster_revision
            and active_verified(team.workspace, member.user_id)
            for member in members
        )
    )


def version_eligible(
    version: AssignmentVersion, members: list[AssignmentParticipation]
) -> bool:
    return (
        version.submission_mode == "team" and 2 <= len(members) <= version.max_team_size
    )


@transaction.atomic
def create_team(
    user: User, session_key: str | None, assignment_id: uuid.UUID, *, name: str
) -> AssignmentTeam:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment, teacher=True)
    require_assignment_mutable(assignment)
    if assignment.teams.count() >= MAX_TEAMS:
        raise AssignmentCapacity(
            "team_capacity", "This assignment has reached its 50 lifetime team limit."
        )
    current = current_member(user, session_key, assignment, teacher=True)
    team = AssignmentTeam.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        created_by=current,
        name=label(name, 80),
    )
    current_member(user, session_key, assignment, teacher=True)
    return team


@transaction.atomic
def update_team(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    team_id: uuid.UUID,
    *,
    expected_revision: int,
    name: str | None = None,
    archived: bool | None = None,
) -> AssignmentTeam:
    assignment = lock_learning(assignment_id)
    current_member(user, session_key, assignment, teacher=True)
    # Archiving reduces authority and remains available while the assignment is archived.
    if name is not None or archived is not True:
        require_assignment_mutable(assignment)
    team = get_object_or_404(AssignmentTeam, assignment=assignment, id=team_id)
    require_revision(team.revision, expected_revision)
    if name is not None:
        team.name = label(name, 80)
    current_member(user, session_key, assignment, teacher=True)
    if archived is True and team.archived_at is None:
        team.archived_at = timezone.now()
        invalidate_team(team, reason="team_archived")
    elif archived is False and team.archived_at is not None:
        team.archived_at = None
        invalidate_team(team)
    else:
        if archived is False:
            team.archived_at = None
        team.revision = increment(team.revision)
        team.save()
    current_member(user, session_key, assignment, teacher=True)
    return team


@transaction.atomic
def offer_team_member(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    team_id: uuid.UUID,
    *,
    participation_id: uuid.UUID,
    expected_team_revision: int,
    expected_participation_revision: int,
) -> AssignmentTeam:
    assignment = lock_learning(assignment_id)
    current_member(user, session_key, assignment, teacher=True)
    require_assignment_mutable(assignment)
    team = get_object_or_404(
        AssignmentTeam, assignment=assignment, id=team_id, archived_at__isnull=True
    )
    participation = get_object_or_404(
        AssignmentParticipation, assignment=assignment, id=participation_id
    )
    require_revision(team.revision, expected_team_revision)
    require_revision(participation.revision, expected_participation_revision)
    if participation.state != "accepted" or not active_verified(
        assignment.workspace, participation.user_id
    ):
        raise AssignmentConflict(
            "Only a currently accepted, verified member can receive this team offer."
        )
    if participation.team_id != team.id and team.participations.count() >= 6:
        raise AssignmentCapacity(
            "team_roster_capacity", "A team supports at most six members."
        )
    current_member(user, session_key, assignment, teacher=True)
    if participation.team_id is not None and participation.team_id != team.id:
        invalidate_team(AssignmentTeam.objects.get(id=participation.team_id))
    invalidate_team(team)
    participation.team = team
    participation.team_offer_expires_at = timezone.now() + OFFER_DURATION
    participation.team_consent_revision = None
    participation.team_consented_at = None
    participation.revision = increment(participation.revision)
    participation.save()
    current_member(user, session_key, assignment, teacher=True)
    if not active_verified(assignment.workspace, participation.user_id):
        raise AssignmentConflict(
            "The recipient is no longer an eligible workspace member."
        )
    return team


@transaction.atomic
def remove_team_member(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    team_id: uuid.UUID,
    participation_id: uuid.UUID,
    *,
    expected_team_revision: int,
    expected_participation_revision: int,
) -> AssignmentTeam:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment)
    team = get_object_or_404(AssignmentTeam, assignment=assignment, id=team_id)
    participation = get_object_or_404(
        AssignmentParticipation, assignment=assignment, id=participation_id, team=team
    )
    if participation.user_id != current.id:
        current_member(user, session_key, assignment, teacher=True)
    require_revision(team.revision, expected_team_revision)
    require_revision(participation.revision, expected_participation_revision)
    current_member(
        user, session_key, assignment, teacher=participation.user_id != current.id
    )
    invalidate_team(team)
    participation.team = None
    participation.team_offer_expires_at = None
    participation.team_consent_revision = None
    participation.team_consented_at = None
    participation.revision = increment(participation.revision)
    participation.save()
    current_member(
        user, session_key, assignment, teacher=participation.user_id != current.id
    )
    return team


@transaction.atomic
def approve_team(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    team_id: uuid.UUID,
    *,
    expected_revision: int,
    roster_revision: int,
) -> AssignmentTeam:
    assignment = lock_learning(assignment_id)
    current_member(user, session_key, assignment, teacher=True)
    require_assignment_mutable(assignment)
    team = get_object_or_404(
        AssignmentTeam, assignment=assignment, id=team_id, archived_at__isnull=True
    )
    require_revision(team.revision, expected_revision)
    require_revision(team.roster_revision, roster_revision)
    members = roster(team)
    if not 2 <= len(members) <= 6 or not all(
        active_verified(assignment.workspace, member.user_id) for member in members
    ):
        raise AssignmentConflict(
            "Approval requires two through six accepted, verified workspace members."
        )
    team.approved_by = current_member(user, session_key, assignment, teacher=True)
    team.approved_at = timezone.now()
    team.approved_roster_revision = team.roster_revision
    team.revision = increment(team.revision)
    team.save()
    current_member(user, session_key, assignment, teacher=True)
    if not all(
        active_verified(assignment.workspace, member.user_id) for member in members
    ):
        raise AssignmentConflict("A roster member is no longer eligible for approval.")
    return team


@transaction.atomic
def consent_team(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    expected_revision: int,
    team_id: uuid.UUID,
    roster_revision: int,
) -> AssignmentParticipation:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment)
    require_assignment_mutable(assignment)
    participation = own_participation(assignment, current)
    if participation.team_id != team_id:
        raise NotFound("Team offer unavailable.")
    team = get_object_or_404(
        AssignmentTeam, id=team_id, assignment=assignment, archived_at__isnull=True
    )
    require_revision(team.roster_revision, roster_revision)
    if (
        participation.revision == expected_revision + 1
        and participation.team_consent_revision == roster_revision
    ):
        return participation
    require_revision(participation.revision, expected_revision)
    if (
        participation.state != "accepted"
        or participation.team_offer_expires_at is None
        or participation.team_offer_expires_at <= timezone.now()
    ):
        raise AssignmentConflict(
            "This team offer is no longer available. Ask a teacher for a new offer."
        )
    current_member(user, session_key, assignment)
    participation.team_consent_revision = roster_revision
    participation.team_consented_at = timezone.now()
    participation.revision = increment(participation.revision)
    participation.save()
    current_member(user, session_key, assignment)
    return participation

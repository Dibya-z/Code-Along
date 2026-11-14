"""Explicit recipient consent; ordinary source grants remain a separate domain."""

import uuid
from datetime import timedelta

from allauth.account.models import EmailAddress
from django.db import transaction
from django.db.models import F
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from code_along.accounts.models import User
from code_along.projects.revision_services import current_actor
from code_along.workspaces.models import Workspace, WorkspaceMembership
from code_along.workspaces.policies import require_membership

from .models import (
    Assignment,
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentWork,
)
from .policies import require_assignment_mutable, require_assignment_teacher
from .services import AssignmentCapacity, AssignmentConflict, lock_assignment

MAX_PARTICIPATIONS = 100
MAX_TEAMS = 50
MAX_WORK = 200
MAX_REVISION = 9007199254740991
OFFER_DURATION = timedelta(days=7)


def increment(value: int) -> int:
    if value >= MAX_REVISION:
        raise AssignmentConflict("This record has reached its revision limit.")
    return value + 1


def lock_learning(assignment_id: uuid.UUID) -> Assignment:
    """Workspace serializes all product writes; child locks retain one fixed order."""
    assignment = lock_assignment(assignment_id)
    list(
        AssignmentTeam.objects.select_for_update()
        .filter(assignment=assignment)
        .order_by("id")
    )
    list(
        AssignmentParticipation.objects.select_for_update()
        .filter(assignment=assignment)
        .order_by("id")
    )
    list(
        AssignmentWork.objects.select_for_update()
        .filter(assignment=assignment)
        .order_by("id")
    )
    return assignment


def current_member(
    user: User,
    session_key: str | None,
    assignment: Assignment,
    *,
    teacher: bool = False,
) -> User:
    current = current_actor(user, session_key)
    if teacher:
        require_assignment_teacher(assignment.workspace, current)
    else:
        require_membership(assignment.workspace, current)
    return current


def active_verified(workspace: Workspace, user_id: uuid.UUID) -> bool:
    return (
        WorkspaceMembership.objects.filter(
            workspace=workspace, user_id=user_id, active=True, user__is_active=True
        ).exists()
        and EmailAddress.objects.filter(
            user_id=user_id,
            verified=True,
            primary=True,
            email__iexact=User.objects.values("email").get(id=user_id)["email"],
        ).exists()
    )


def own_participation(assignment: Assignment, user: User) -> AssignmentParticipation:
    return get_object_or_404(AssignmentParticipation, assignment=assignment, user=user)


def require_revision(actual: int, expected: int) -> None:
    if actual != expected:
        raise AssignmentConflict()


def retire_work(assignment: Assignment, reason: str, **scope: object) -> None:
    AssignmentWork.objects.filter(
        assignment=assignment, state="active", **scope
    ).update(state="retired", retired_at=timezone.now(), retired_reason=reason)


def invalidate_team(team: AssignmentTeam, *, reason: str = "roster_changed") -> None:
    team.revision = increment(team.revision)
    team.roster_revision = increment(team.roster_revision)
    team.approved_roster_revision = None
    team.approved_by = None
    team.approved_at = None
    team.save()
    remaining = team.participations.filter(state="accepted")
    if remaining.filter(revision__gte=MAX_REVISION).exists():
        raise AssignmentConflict("A roster record has reached its revision limit.")
    # A changed roster is a new offer, never renewed consent. Previously expired
    # offers must not trap remaining members when their old consent becomes stale.
    remaining.update(
        revision=F("revision") + 1,
        team_offer_expires_at=timezone.now() + OFFER_DURATION,
        team_consent_revision=None,
        team_consented_at=None,
    )
    retire_work(team.assignment, reason, team=team)


def end_participation(participation: AssignmentParticipation, state: str) -> None:
    if participation.team_id is not None:
        invalidate_team(AssignmentTeam.objects.get(id=participation.team_id))
    retire_work(
        participation.assignment, "participation_ended", participation=participation
    )
    participation.state = state
    participation.revision = increment(participation.revision)
    participation.ended_at = timezone.now()
    participation.team = None
    participation.team_offer_expires_at = None
    participation.team_consent_revision = None
    participation.team_consented_at = None
    participation.save()


@transaction.atomic
def offer_participation(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    recipient_id: uuid.UUID,
    expected_revision: int | None = None,
) -> tuple[AssignmentParticipation, bool]:
    assignment = lock_learning(assignment_id)
    current_member(user, session_key, assignment, teacher=True)
    require_assignment_mutable(assignment)
    if not active_verified(assignment.workspace, recipient_id):
        raise PermissionDenied("Choose a verified active workspace member.")
    existing = AssignmentParticipation.objects.filter(
        assignment=assignment, user_id=recipient_id
    ).first()
    now = timezone.now()
    if existing is not None:
        if expected_revision is None:
            raise AssignmentConflict(
                "Reload this participation before offering it again."
            )
        require_revision(existing.revision, expected_revision)
        if existing.state == "accepted" or (
            existing.state == "invited" and existing.invite_expires_at > now
        ):
            raise AssignmentConflict(
                "This member already has a current offer or accepted participation."
            )
        existing.state = "invited"
        existing.revision = increment(existing.revision)
        existing.team = None
        existing.team_offer_expires_at = None
        existing.team_consent_revision = None
        existing.team_consented_at = None
        existing.invited_by = current_member(
            user, session_key, assignment, teacher=True
        )
        existing.invited_at = now
        existing.invite_expires_at = now + OFFER_DURATION
        existing.accepted_at = existing.ended_at = None
        existing.save()
        current_member(user, session_key, assignment, teacher=True)
        if not active_verified(assignment.workspace, recipient_id):
            raise AssignmentConflict(
                "The recipient is no longer an eligible workspace member."
            )
        return existing, False
    if expected_revision is not None:
        raise AssignmentConflict("A new offer has no previous revision.")
    if assignment.participations.count() >= MAX_PARTICIPATIONS:
        raise AssignmentCapacity(
            "participation_capacity",
            "This assignment has reached its 100 lifetime participation limit.",
        )
    current = current_member(user, session_key, assignment, teacher=True)
    record = AssignmentParticipation.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        user_id=recipient_id,
        invited_by=current,
        invited_at=now,
        invite_expires_at=now + OFFER_DURATION,
    )
    current_member(user, session_key, assignment, teacher=True)
    if not active_verified(assignment.workspace, recipient_id):
        raise AssignmentConflict(
            "The recipient is no longer an eligible workspace member."
        )
    return record, True


@transaction.atomic
def transition_participation(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    action: str,
    expected_revision: int,
    participation_id: uuid.UUID | None = None,
) -> AssignmentParticipation:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment, teacher=action == "revoke")
    participation = (
        get_object_or_404(
            AssignmentParticipation, id=participation_id, assignment=assignment
        )
        if action == "revoke"
        else own_participation(assignment, current)
    )
    target = {
        "accept": "accepted",
        "decline": "declined",
        "withdraw": "withdrawn",
        "revoke": "revoked",
    }[action]
    if (
        participation.state == target
        and participation.revision == expected_revision + 1
    ):
        return participation
    require_revision(participation.revision, expected_revision)
    if action == "accept":
        require_assignment_mutable(assignment)
        if (
            participation.state != "invited"
            or participation.invite_expires_at <= timezone.now()
        ):
            raise AssignmentConflict(
                "This offer is no longer available for acceptance."
            )
        participation.state = "accepted"
        participation.revision = increment(participation.revision)
        participation.accepted_at = timezone.now()
        participation.ended_at = None
        current_member(user, session_key, assignment)
        participation.save()
    else:
        if (
            action == "decline"
            and participation.state != "invited"
            or action == "withdraw"
            and participation.state != "accepted"
        ):
            raise AssignmentConflict(
                "This participation no longer permits that action."
            )
        current_member(user, session_key, assignment, teacher=action == "revoke")
        end_participation(participation, target)
    current_member(user, session_key, assignment, teacher=action == "revoke")
    return participation


def invalidate_workspace_membership(workspace: Workspace, user_id: uuid.UUID) -> None:
    """Call inside the normal workspace-first deactivation transaction, before project writes."""
    assignment_ids = list(
        AssignmentParticipation.objects.filter(
            workspace=workspace, user_id=user_id, state__in=["invited", "accepted"]
        )
        .order_by("assignment_id")
        .values_list("assignment_id", flat=True)
    )
    for assignment_id in assignment_ids:
        assignment = lock_learning(assignment_id)
        participation = AssignmentParticipation.objects.get(
            assignment=assignment, user_id=user_id
        )
        end_participation(participation, "revoked")

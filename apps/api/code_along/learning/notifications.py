"""Explicit coalesced learning changes, flushed once at the outer domain boundary."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field

from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from .models import Assignment, AssignmentParticipation, LearningNotificationStream
from .notification_types import MAX_GENERATION, LearningUnavailable


@dataclass
class _AudienceChanges:
    users: set[uuid.UUID] = field(default_factory=set)
    teaching: bool = False
    all_participants: bool = False


class LearningChanges:
    def __init__(self) -> None:
        self.assignments: dict[uuid.UUID, _AudienceChanges] = {}

    def add(
        self,
        assignment_id: uuid.UUID,
        user_ids: Iterable[uuid.UUID] = (),
        *,
        teaching: bool = True,
        all_participants: bool = False,
    ) -> None:
        change = self.assignments.setdefault(assignment_id, _AudienceChanges())
        change.users.update(user_ids)
        change.teaching |= teaching
        change.all_participants |= all_participants

    def merge(self, other: "LearningChanges") -> None:
        for assignment_id, change in other.assignments.items():
            self.add(
                assignment_id,
                change.users,
                teaching=change.teaching,
                all_participants=change.all_participants,
            )


def create_teaching_stream(assignment: Assignment) -> None:
    LearningNotificationStream.objects.create(
        assignment=assignment, workspace=assignment.workspace
    )


def create_participant_stream(participation: AssignmentParticipation) -> None:
    LearningNotificationStream.objects.create(
        assignment=participation.assignment,
        workspace=participation.workspace,
        audience_user_id=participation.user_id,
        participation=participation,
    )


def roster_users(assignment_id: uuid.UUID, team_id: uuid.UUID | None) -> set[uuid.UUID]:
    if team_id is None:
        return set()
    return set(
        AssignmentParticipation.objects.filter(
            assignment_id=assignment_id, team_id=team_id, state="accepted"
        ).values_list("user_id", flat=True)
    )


def workspace_changes(
    workspace_id: uuid.UUID, *, all_participants: bool
) -> LearningChanges:
    changes = LearningChanges()
    for assignment_id in Assignment.objects.filter(
        workspace_id=workspace_id
    ).values_list("id", flat=True):
        changes.add(assignment_id, all_participants=all_participants)
    return changes


def _wake() -> None:
    try:
        from code_along.events.tasks import wake_dispatcher

        wake_dispatcher()
    except Exception:
        pass  # Durable pending heads are repaired by the existing scheduler.


def flush_learning_changes(changes: LearningChanges) -> None:
    if not connection.in_atomic_block:
        raise LearningUnavailable()
    if not changes.assignments:
        return
    predicate = Q(pk__in=[])
    expected: set[tuple[uuid.UUID, uuid.UUID | None]] = set()
    for assignment_id, change in changes.assignments.items():
        users = set(change.users)
        if change.all_participants:
            users.update(
                AssignmentParticipation.objects.filter(
                    assignment_id=assignment_id
                ).values_list("user_id", flat=True)
            )
        audience = Q(audience_user_id__in=users)
        expected.update((assignment_id, user_id) for user_id in users)
        if change.teaching:
            audience |= Q(audience_user__isnull=True)
            expected.add((assignment_id, None))
        predicate |= Q(assignment_id=assignment_id) & audience
    rows = list(
        LearningNotificationStream.objects.select_for_update()
        .filter(predicate)
        .order_by("id")
    )
    if {(row.assignment_id, row.audience_user_id) for row in rows} != expected:
        raise LearningUnavailable()
    now = timezone.now()
    for row in rows:
        if row.head_generation >= MAX_GENERATION:
            raise LearningUnavailable()
        clean = row.head_generation == row.published_generation
        row.head_generation += 1
        row.updated_at = now
        fields = ["head_generation", "updated_at"]
        if clean:
            row.available_at, row.attempts, row.last_error_code = now, 0, ""
            fields += ["available_at", "attempts", "last_error_code"]
        row.save(update_fields=fields)
    if rows:
        transaction.on_commit(_wake)

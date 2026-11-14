"""Actual session/audience authorization shared by HTTP and the private consumer."""

import uuid

from django.core.exceptions import ObjectDoesNotExist
from django.db import DatabaseError
from rest_framework.exceptions import APIException

from code_along.collaboration.services import AdmissionError, session_user
from code_along.workspaces.policies import require_membership

from .models import Assignment, LearningNotificationStream
from .notification_types import (
    Audience,
    LearningAccess,
    LearningDenied,
    LearningHead,
    LearningUnavailable,
    StreamIdentity,
)


def _read(
    session_key: str | None,
    assignment_id: uuid.UUID,
    audience: Audience,
    expected_user_id: uuid.UUID | None,
) -> tuple[LearningAccess, int]:
    try:
        user, _ = session_user(session_key)
        if expected_user_id is not None and user.id != expected_user_id:
            raise LearningDenied()
        assignment = Assignment.objects.select_related("workspace").get(
            id=assignment_id
        )
        member = require_membership(assignment.workspace, user)
        if audience == "teaching":
            if member.role not in {"owner", "instructor"}:
                raise LearningDenied()
            stream = LearningNotificationStream.objects.get(
                assignment=assignment,
                audience_user__isnull=True,
                participation__isnull=True,
            )
        elif audience == "participant":
            # Every frozen participant references a real lifetime participation.
            # Ended/declined states retain read authority, never new eligibility.
            stream = LearningNotificationStream.objects.get(
                assignment=assignment,
                audience_user=user,
                participation__assignment=assignment,
                participation__user=user,
                participation__workspace=assignment.workspace,
            )
        else:
            raise LearningDenied()
        if stream.workspace_id != assignment.workspace_id:
            raise LearningDenied()
        identity = StreamIdentity(
            stream.id,
            stream.assignment_id,
            stream.workspace_id,
            stream.audience_user_id,
            stream.participation_id,
        )
        return LearningAccess(user.id, identity), stream.head_generation
    except (AdmissionError, APIException, ObjectDoesNotExist):
        raise LearningDenied() from None
    except DatabaseError:
        raise LearningUnavailable() from None


def authorize_learning_stream(
    session_key: str | None,
    assignment_id: uuid.UUID,
    audience: Audience,
    *,
    expected_user_id: uuid.UUID | None = None,
) -> LearningAccess:
    return _read(session_key, assignment_id, audience, expected_user_id)[0]


def read_learning_head(
    session_key: str | None,
    assignment_id: uuid.UUID,
    audience: Audience,
    *,
    expected_user_id: uuid.UUID | None = None,
) -> LearningHead:
    access, generation = _read(session_key, assignment_id, audience, expected_user_id)
    return LearningHead(access, generation)

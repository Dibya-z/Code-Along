from django.shortcuts import get_object_or_404
from rest_framework.exceptions import PermissionDenied

from code_along.accounts.models import User
from code_along.learning.models import Assignment
from code_along.learning.participation_services import current_member

from .feedback_contracts import feedback_error
from .models import Submission


def require_reviewer(
    assignment: Assignment,
    submission_id: object,
    actor: User,
    session_key: str | None,
    *,
    open_parents: bool,
) -> tuple[User, Submission]:
    current = current_member(actor, session_key, assignment, teacher=True)
    submission = get_object_or_404(Submission, assignment=assignment, id=submission_id)
    if submission.participants.filter(user=current).exists():
        # This precedes EVERY feedback draft/publication lookup for authoring.
        raise PermissionDenied("Another current teacher must review this submission.")
    if open_parents and (
        assignment.archived_at is not None
        or assignment.workspace.archived_at is not None
    ):
        raise feedback_error(
            "feedback_review_unavailable",
            "Restore the review parents before editing or publishing feedback.",
        )
    return current, submission

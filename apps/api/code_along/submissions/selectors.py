import uuid

from django.db.models import QuerySet
from django.shortcuts import get_object_or_404

from code_along.accounts.models import User
from code_along.learning.models import Assignment
from code_along.learning.participation_services import active_verified
from code_along.learning.policies import is_teacher
from code_along.workspaces.policies import require_membership

from .models import Submission


def authorized_rows(assignment: Assignment, actor: User) -> QuerySet[Submission]:
    require_membership(assignment.workspace, actor)
    # VerifiedAccount alone could be stale inside a raced request.
    if not active_verified(assignment.workspace, actor.id):
        return Submission.objects.none()
    rows = Submission.objects.filter(
        assignment=assignment,
        artifact_scope="submission",
        revision__artifact_scope="submission",
        revision__provenance="client_submitted_snapshot",
        revision__manifest_version=1,
    )
    if not is_teacher(assignment.workspace, actor):
        rows = rows.filter(participants__user=actor)
    return rows


def readable_submission(
    assignment: Assignment, submission_id: uuid.UUID, actor: User
) -> Submission:
    return get_object_or_404(
        authorized_rows(assignment, actor).select_related(
            "revision", "assignment_version"
        ),
        id=submission_id,
    )

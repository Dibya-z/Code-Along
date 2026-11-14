"""Manual teacher decisions over immutable submissions, without source access."""

import uuid

from django.db import transaction
from django.db.models import Max
from django.utils import timezone

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.events.contracts import utc
from code_along.learning.contracts import canonical, digest
from code_along.learning.models import Assignment
from code_along.learning.services import lock_assignment

from . import feedback_contracts as contract
from .feedback_contracts import feedback_error
from .feedback_policies import require_reviewer
from .models import (
    FeedbackPublication,
    InstructorFeedback,
    Submission,
    SubmissionAssignmentUsage,
    SubmissionWorkspaceUsage,
)


def lock_review(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    submission_id: uuid.UUID,
    *,
    open_parents: bool,
) -> tuple[Assignment, User, Submission]:
    assignment = lock_assignment(assignment_id)
    current, submission = require_reviewer(
        assignment, submission_id, user, session_key, open_parents=open_parents
    )
    submission = Submission.objects.select_for_update().get(id=submission.id)
    return assignment, current, submission


@transaction.atomic
def save_draft(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    submission_id: uuid.UUID,
    *,
    expected_revision: int,
    comments: str,
    assessment_status: str | None,
) -> InstructorFeedback:
    comments, assessment_status = contract.comments(comments, assessment_status)
    assignment, current, submission = lock_review(
        user, session_key, assignment_id, submission_id, open_parents=True
    )
    draft = (
        InstructorFeedback.objects.select_for_update()
        .filter(submission=submission)
        .first()
    )
    actual = draft.revision if draft is not None else 0
    if expected_revision != actual:
        raise feedback_error(
            "feedback_revision_conflict",
            "The feedback draft changed. Review its current revision before saving.",
        )
    now = timezone.now()
    if draft is None:
        draft = InstructorFeedback(
            submission=submission,
            assignment=assignment,
            workspace=assignment.workspace,
            revision=1,
            draft_comments=comments,
            draft_assessment_status=assessment_status,
            last_edited_by=current,
            updated_at=now,
        )
    else:
        draft.revision = contract.increment(draft.revision)
        draft.draft_comments = comments
        draft.draft_assessment_status = assessment_status
        draft.last_edited_by = current
        draft.updated_at = now
    require_reviewer(assignment, submission.id, user, session_key, open_parents=True)
    draft.save()
    require_reviewer(assignment, submission.id, user, session_key, open_parents=True)
    return draft


def publication_metadata(record: FeedbackPublication, version_id: uuid.UUID) -> int:
    data = {
        "codec": "code-along.manual-feedback-metadata",
        "version": 1,
        "assignment_version_id": str(version_id),
        "assessment_kind": "manual",
    }
    for field in record._meta.concrete_fields:
        if field.name == "metadata_bytes":
            continue
        value = getattr(record, field.attname)
        if isinstance(value, uuid.UUID):
            value = str(value)
        if hasattr(value, "isoformat"):
            value = utc(value)
        data[field.attname] = value
    return len(canonical(data))


@transaction.atomic
def publish_feedback(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    submission_id: uuid.UUID,
    *,
    expected_revision: int,
    client_request_id: uuid.UUID,
) -> tuple[FeedbackPublication, bool]:
    assignment, current, submission = lock_review(
        user, session_key, assignment_id, submission_id, open_parents=False
    )
    draft = (
        InstructorFeedback.objects.select_for_update()
        .filter(submission=submission)
        .first()
    )
    if draft is None:
        require_reviewer(
            assignment, submission.id, user, session_key, open_parents=True
        )
        raise feedback_error(
            "feedback_draft_required", "Save a feedback draft before publishing it."
        )
    request_sha256 = digest(
        [
            "code-along.feedback-request",
            1,
            str(submission.id),
            str(current.id),
            expected_revision,
            str(client_request_id),
        ]
    )
    original = FeedbackPublication.objects.filter(
        feedback=draft, published_by=current, client_request_id=client_request_id
    ).first()
    if original is not None:
        if original.request_sha256 != request_sha256:
            raise feedback_error(
                "feedback_nonce_conflict",
                "This publication identity already binds different values.",
            )
        require_reviewer(
            assignment, submission.id, user, session_key, open_parents=False
        )
        return original, False
    require_reviewer(assignment, submission.id, user, session_key, open_parents=True)
    if draft.revision != expected_revision:
        raise feedback_error(
            "feedback_revision_conflict",
            "The feedback draft changed. Review it before publishing.",
        )
    next_revision = contract.increment(draft.revision)
    text, status = contract.comments(
        draft.draft_comments, draft.draft_assessment_status, publish=True
    )
    assert status is not None
    last = draft.publications.aggregate(number=Max("number"))["number"] or 0
    if last >= contract.MAX_PUBLICATIONS:
        raise feedback_error(
            "feedback_publication_capacity",
            "This submission reached its retained publication limit.",
        )
    now = timezone.now()
    record = FeedbackPublication(
        feedback=draft,
        submission=submission,
        assignment=assignment,
        workspace=assignment.workspace,
        number=last + 1,
        source_revision=expected_revision,
        published_by=current,
        publisher_display_name=public_display_name(current.display_name),
        published_at=now,
        client_request_id=client_request_id,
        request_sha256=request_sha256,
        comments=text,
        assessment_status=status,
        content_sha256=digest(
            [
                "code-along.manual-feedback",
                1,
                str(submission.id),
                str(submission.assignment_version_id),
                last + 1,
                status,
                text,
            ]
        ),
    )
    record.metadata_bytes = publication_metadata(
        record, submission.assignment_version_id
    )
    if record.metadata_bytes > contract.MAX_PUBLICATION_METADATA_BYTES:
        raise feedback_error(
            "feedback_metadata_limit",
            "This publication exceeds its retained metadata limit.",
        )
    assignment_usage, _ = SubmissionAssignmentUsage.objects.get_or_create(
        assignment=assignment, defaults={"workspace": assignment.workspace}
    )
    workspace_usage, _ = SubmissionWorkspaceUsage.objects.get_or_create(
        workspace=assignment.workspace
    )
    if (
        draft.published_metadata_bytes + record.metadata_bytes
        > contract.MAX_SUBMISSION_FEEDBACK_BYTES
        or assignment_usage.feedback_metadata_bytes + record.metadata_bytes
        > contract.MAX_ASSIGNMENT_FEEDBACK_BYTES
        or workspace_usage.feedback_metadata_bytes + record.metadata_bytes
        > contract.MAX_WORKSPACE_FEEDBACK_BYTES
    ):
        raise feedback_error(
            "feedback_metadata_capacity",
            "The retained manual feedback metadata budget is full.",
        )
    require_reviewer(assignment, submission.id, user, session_key, open_parents=True)
    record.save(force_insert=True)
    draft.revision = next_revision
    draft.current_publication = record
    draft.published_metadata_bytes += record.metadata_bytes
    # Publication changes the container's CAS/pointer, not the last draft editor.
    draft.save(
        update_fields=["revision", "current_publication", "published_metadata_bytes"]
    )
    for usage in (assignment_usage, workspace_usage):
        usage.feedback_metadata_bytes += record.metadata_bytes
        usage.save(update_fields=["feedback_metadata_bytes"])
    require_reviewer(assignment, submission.id, user, session_key, open_parents=True)
    return record, True

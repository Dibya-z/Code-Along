"""Bounded SQL-derived history with current eligibility kept separate."""

import uuid
from datetime import datetime
from typing import Any

from allauth.account.models import EmailAddress
from django.core.exceptions import ObjectDoesNotExist
from django.db import DatabaseError, transaction
from django.db.models import Exists, OuterRef
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import APIException

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.events.contracts import utc
from code_along.projects.policies import visible_projects
from code_along.submissions.models import FeedbackPublication, SubmissionParticipant
from code_along.submissions.policies import new_submit_reason
from code_along.workspaces.models import WorkspaceMembership

from .models import (
    Assignment,
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentVersion,
    AssignmentWork,
    AssignmentWorkMember,
)
from .notification_types import LearningUnavailable
from .participation_services import current_member
from .selectors import public_version_scope

type OwnProgress = dict[str, Any]
type ProgressPage = dict[str, Any]


def _scope(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    version_id: uuid.UUID,
    *,
    teacher: bool,
) -> tuple[Assignment, AssignmentVersion, User]:
    assignment = get_object_or_404(
        Assignment.objects.select_related("workspace"), id=assignment_id
    )
    current = current_member(user, session_key, assignment, teacher=teacher)
    version = get_object_or_404(
        AssignmentVersion.objects.filter(public_version_scope()).only(
            "id", "assignment_id", "submission_mode", "max_team_size"
        ),
        assignment=assignment,
        id=version_id,
    )
    return assignment, version, current


def _snapshot(
    assignment: Assignment,
    own_user_id: uuid.UUID | None = None,
) -> tuple[list[dict[str, Any]], dict[uuid.UUID, dict[str, Any]]]:
    membership = WorkspaceMembership.objects.filter(
        workspace=assignment.workspace,
        user_id=OuterRef("user_id"),
        active=True,
        user__is_active=True,
    )
    email = EmailAddress.objects.filter(
        user_id=OuterRef("user_id"),
        primary=True,
        verified=True,
        email__iexact=OuterRef("user__email"),
    )
    query = (
        AssignmentParticipation.objects.filter(assignment=assignment)
        .annotate(member_active=Exists(membership), email_verified=Exists(email))
        .order_by("user_id")
        .values(
            "id",
            "user_id",
            "user__display_name",
            "state",
            "invite_expires_at",
            "team_id",
            "team_consent_revision",
            "member_active",
            "email_verified",
        )
    )
    if own_user_id is None:
        records = [dict(row) for row in query[:101]]
    else:
        own = query.filter(user_id=own_user_id).first()
        records = [dict(own)] if own is not None else []
        if own is not None and own["team_id"] is not None:
            records += [
                dict(row)
                for row in query.filter(
                    team_id=own["team_id"], state="accepted"
                ).exclude(user_id=own_user_id)[:7]
            ]
    if len(records) > 100:
        raise LearningUnavailable()
    team_query = AssignmentTeam.objects.filter(assignment=assignment)
    if own_user_id is not None:
        team_query = team_query.filter(
            id__in={row["team_id"] for row in records if row["team_id"] is not None}
        )
    teams = {
        row["id"]: dict(row)
        for row in team_query.values(
            "id", "archived_at", "roster_revision", "approved_roster_revision"
        )[:51]
    }
    if len(teams) > 50:
        raise LearningUnavailable()
    return records, teams


def _eligibility(
    assignment: Assignment,
    version: AssignmentVersion,
    part: dict[str, Any] | None,
    parts: list[dict[str, Any]],
    teams: dict[uuid.UUID, dict[str, Any]],
    now: datetime,
) -> str:
    if part is None:
        return "not_offered"
    if part["state"] != "accepted":
        return (
            "expired"
            if part["state"] == "invited" and part["invite_expires_at"] <= now
            else str(part["state"])
        )
    if not part["member_active"] or not part["email_verified"]:
        return "unavailable"
    if (
        assignment.archived_at is not None
        or assignment.workspace.archived_at is not None
    ):
        return "archived"
    if version.submission_mode == "individual":
        return "eligible"
    team = teams.get(part["team_id"])
    if team is None or team["archived_at"] is not None:
        return "team_pending"
    roster = [
        row
        for row in parts
        if row["state"] == "accepted" and row["team_id"] == team["id"]
    ]
    if len(roster) > version.max_team_size:
        return "policy_ineligible"
    if (
        len(roster) < 2
        or team["approved_roster_revision"] != team["roster_revision"]
        or any(
            row["team_consent_revision"] != team["roster_revision"]
            or not row["member_active"]
            or not row["email_verified"]
            for row in roster
        )
    ):
        return "team_pending"
    return "eligible"


def _history(
    assignment: Assignment, version: AssignmentVersion, user_ids: list[uuid.UUID]
) -> tuple[
    dict[uuid.UUID, dict[str, Any]], dict[uuid.UUID, dict[str, Any]], set[uuid.UUID]
]:
    latest: dict[uuid.UUID, dict[str, Any]] = {}
    rows = (
        SubmissionParticipant.objects.filter(
            assignment=assignment,
            assignment_version=version,
            user_id__in=user_ids,
            submission__assignment=assignment,
            submission__workspace=assignment.workspace,
            submission__artifact_scope="submission",
            submission__revision__artifact_scope="submission",
            submission__revision__provenance="client_submitted_snapshot",
            submission__revision__manifest_version=1,
        )
        .order_by("-submission__assignment_submission_number", "user_id")
        .values(
            "user_id",
            "submission_id",
            "submission__assignment_submission_number",
            "submission__submitted_at",
            "submission__source_manifest_sha256",
        )
    )
    for row in rows:
        latest.setdefault(row["user_id"], dict(row))
    submission_ids = {row["submission_id"] for row in latest.values()}
    publications = {
        row["submission_id"]: dict(row)
        for row in FeedbackPublication.objects.filter(submission_id__in=submission_ids)
        .order_by("submission_id", "-number")
        .distinct("submission_id")
        .values("id", "submission_id", "assessment_status", "published_at")
    }
    # This is only a historical started-work marker, never graded participants.
    started = set(
        AssignmentWorkMember.objects.filter(
            assignment=assignment,
            work__assignment_version=version,
            user_id__in=user_ids,
        )
        .values_list("user_id", flat=True)
        .distinct()
    )
    return latest, publications, started


def _row(
    assignment: Assignment,
    version: AssignmentVersion,
    user_id: uuid.UUID,
    part: dict[str, Any] | None,
    parts: list[dict[str, Any]],
    teams: dict[uuid.UUID, dict[str, Any]],
    latest: dict[uuid.UUID, dict[str, Any]],
    publications: dict[uuid.UUID, dict[str, Any]],
    started: set[uuid.UUID],
    now: datetime,
) -> dict[str, Any]:
    submission = latest.get(user_id)
    assessment = publications.get(submission["submission_id"]) if submission else None
    state = (
        assessment["assessment_status"]
        if assessment
        else "submitted"
        if submission
        else "in_progress"
        if user_id in started
        else "not_started"
    )
    return {
        "assignment_id": str(assignment.id),
        "assignment_version_id": str(version.id),
        "user_id": str(user_id),
        "state": state,
        "eligibility_state": _eligibility(assignment, version, part, parts, teams, now),
        "latest_submission": {
            "id": str(submission["submission_id"]),
            "number": submission["submission__assignment_submission_number"],
            "submitted_at": utc(submission["submission__submitted_at"]),
            "source_manifest_sha256": submission["submission__source_manifest_sha256"],
        }
        if submission
        else None,
        "latest_assessment": {
            "publication_id": str(assessment["id"]),
            "assessment_status": assessment["assessment_status"],
            "published_at": utc(assessment["published_at"]),
            "assessment_kind": "manual",
        }
        if assessment
        else None,
    }


def _can_submit(
    assignment: Assignment,
    version: AssignmentVersion,
    current: User,
    part: dict[str, Any] | None,
    teams: dict[uuid.UUID, dict[str, Any]],
    now: datetime,
) -> bool:
    if part is None or part["state"] != "accepted":
        return False
    try:
        with transaction.atomic():
            query = AssignmentWork.objects.filter(
                assignment=assignment, assignment_version=version, state="active"
            )
            if version.submission_mode == "individual":
                query = query.filter(
                    subject_kind="individual", participation_id=part["id"]
                )
            else:
                team = teams.get(part["team_id"])
                if team is None:
                    return False
                query = query.filter(
                    subject_kind="team",
                    team_id=team["id"],
                    team_roster_revision=team["roster_revision"],
                )
            work = query.select_related(
                "assignment_version", "participation", "team"
            ).first()
            if work is None:
                return False
            work.assignment, work.workspace = assignment, assignment.workspace
            project = (
                visible_projects(current)
                .select_related("runtime_profile")
                .filter(id=work.project_id)
                .first()
            )
            if project is not None:
                project.workspace = assignment.workspace
            return new_submit_reason(work, current, project, now) is None
    except (APIException, ObjectDoesNotExist, DatabaseError):
        return False  # Advisory source availability cannot erase historical state.


def own_progress(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    assignment_version_id: uuid.UUID,
) -> OwnProgress:
    assignment, version, current = _scope(
        user, session_key, assignment_id, assignment_version_id, teacher=False
    )
    parts, teams = _snapshot(assignment, current.id)
    part = next((row for row in parts if row["user_id"] == current.id), None)
    latest, publications, started = _history(assignment, version, [current.id])
    now = timezone.now()
    result = _row(
        assignment,
        version,
        current.id,
        part,
        parts,
        teams,
        latest,
        publications,
        started,
        now,
    )
    result["can_submit"] = _can_submit(assignment, version, current, part, teams, now)
    current_member(user, session_key, assignment)
    return result


def teacher_progress(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    assignment_version_id: uuid.UUID,
    offset: int = 0,
    limit: int = 50,
) -> ProgressPage:
    if (
        type(offset) is not int
        or type(limit) is not int
        or not 0 <= offset <= 100000
        or not 1 <= limit <= 100
    ):
        raise ValueError("invalid_progress_page")
    assignment, version, current = _scope(
        user, session_key, assignment_id, assignment_version_id, teacher=True
    )
    parts, teams = _snapshot(assignment)
    selected = parts[offset : offset + limit]
    latest, publications, started = _history(
        assignment, version, [row["user_id"] for row in selected]
    )
    now = timezone.now()
    result = {
        "items": [
            {
                **_row(
                    assignment,
                    version,
                    row["user_id"],
                    row,
                    parts,
                    teams,
                    latest,
                    publications,
                    started,
                    now,
                ),
                "user": {
                    "id": str(row["user_id"]),
                    "display_name": public_display_name(row["user__display_name"]),
                },
            }
            for row in selected
        ],
        "count": len(parts),
    }
    current_member(user, session_key, assignment, teacher=True)
    return result

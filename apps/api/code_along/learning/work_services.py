"""Version-pinned learning bindings over independently authorized source projects."""

import uuid
from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import NotFound

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.projects.frozen_projects import create_from_manifest
from code_along.projects.models import Project, ProjectAccess, RuntimeProfile
from code_along.projects.revision_contract import HELPER_RELEASE
from code_along.projects.revision_services import revision_manifest
from code_along.workspaces.policies import require_membership

from .contracts import digest, label
from .models import (
    Assignment,
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentVersion,
    AssignmentWork,
    AssignmentWorkMember,
)
from .participation_services import (
    MAX_WORK,
    active_verified,
    current_member,
    lock_learning,
    own_participation,
    require_revision,
    retire_work,
)
from .policies import is_teacher, require_assignment_mutable
from .services import AssignmentCapacity, AssignmentConflict, verify_runtime
from .team_services import consent_ready, roster, version_eligible


def subject_members(work: AssignmentWork) -> list[AssignmentParticipation]:
    if work.subject_kind == "individual":
        participation = work.participation
        return (
            [participation]
            if (
                participation is not None
                and participation.state == "accepted"
                and active_verified(work.workspace, participation.user_id)
                and work.assignment_version.submission_mode == "individual"
            )
            else []
        )
    team = work.team
    if team is None or team.roster_revision != work.team_roster_revision:
        return []
    members = roster(team)
    return (
        members
        if consent_ready(team, members)
        and version_eligible(work.assignment_version, members)
        else []
    )


def can_continue(work: AssignmentWork, actor: User, *, project_visible: bool) -> bool:
    if (
        not project_visible
        or work.state != "active"
        or work.assignment.archived_at is not None
        or work.workspace.archived_at is not None
        or work.project.archived_at is not None
    ):
        return False
    users = {member.user_id for member in subject_members(work)}
    return actor.id in users and work.project.owner_id in users


def readable_work(
    assignment: Assignment, work_id: uuid.UUID, actor: User
) -> AssignmentWork:
    require_membership(assignment.workspace, actor)
    work = get_object_or_404(
        AssignmentWork.objects.select_related(
            "assignment", "workspace", "assignment_version", "participation", "team"
        ),
        assignment=assignment,
        id=work_id,
    )
    if (
        not is_teacher(assignment.workspace, actor)
        and not work.members.filter(user=actor).exists()
    ):
        raise NotFound("Learning work unavailable.")
    return work


def request_digest(
    assignment_id: uuid.UUID,
    actor_id: uuid.UUID,
    *,
    assignment_version_id: uuid.UUID,
    subject_kind: str,
    participation_id: uuid.UUID | None,
    team_id: uuid.UUID | None,
    expected_team_roster_revision: int | None,
    expected_participation_revision: int,
    project_name: str,
    sharing: str,
) -> str:
    return digest(
        [
            "code-along.assignment-work",
            1,
            str(assignment_id),
            str(assignment_version_id),
            str(actor_id),
            subject_kind,
            str(participation_id) if participation_id else None,
            str(team_id) if team_id else None,
            expected_team_roster_revision,
            expected_participation_revision,
            project_name,
            sharing,
        ]
    )


@transaction.atomic
def create_work(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    *,
    client_request_id: uuid.UUID,
    assignment_version_id: uuid.UUID,
    expected_participation_revision: int,
    expected_team_roster_revision: int | None,
    project_name: str,
    sharing: str,
) -> tuple[AssignmentWork, bool]:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment)
    project_name = label(project_name, 120)
    previous = AssignmentWork.objects.filter(
        assignment=assignment, created_by=current, client_request_id=client_request_id
    ).first()
    common: dict[str, Any] = {
        "assignment_version_id": assignment_version_id,
        "expected_team_roster_revision": expected_team_roster_revision,
        "expected_participation_revision": expected_participation_revision,
        "project_name": project_name,
        "sharing": sharing,
    }
    if previous is not None:
        # Derive historical subject identity from the original binding, never today's roster.
        expected = request_digest(
            assignment.id,
            current.id,
            subject_kind=previous.subject_kind,
            participation_id=previous.participation_id,
            team_id=previous.team_id,
            **common,
        )
        if expected != previous.request_sha256:
            raise AssignmentConflict(
                "This work request identity was already used for different values."
            )
        return readable_work(assignment, previous.id, current), False
    require_assignment_mutable(assignment)
    version = get_object_or_404(
        AssignmentVersion, assignment=assignment, id=assignment_version_id
    )
    if assignment.current_version_id != version.id:
        raise AssignmentConflict(
            {
                "code": "version_changed",
                "detail": "The published version changed. Review it before starting fresh work.",
            }
        )
    participation = own_participation(assignment, current)
    require_revision(participation.revision, expected_participation_revision)
    if participation.state != "accepted" or not active_verified(
        assignment.workspace, current.id
    ):
        raise AssignmentConflict(
            "Accept a current participation offer before starting work."
        )
    team: AssignmentTeam | None = None
    subject: dict[str, Any]
    if version.submission_mode == "individual":
        if sharing != "private" or expected_team_roster_revision is not None:
            raise AssignmentConflict(
                "Individual work requires an explicit private-project action."
            )
        members = [participation]
        subject = {"subject_kind": "individual", "participation": participation}
    else:
        if (
            sharing != "approved_team_editors"
            or participation.team_id is None
            or expected_team_roster_revision is None
        ):
            raise AssignmentConflict(
                "Review and explicitly share the new project with your approved team roster."
            )
        team = AssignmentTeam.objects.get(id=participation.team_id)
        require_revision(team.roster_revision, expected_team_roster_revision)
        members = roster(team)
        if not consent_ready(team, members) or not version_eligible(version, members):
            raise AssignmentConflict(
                "The exact roster needs current acceptance, consent, approval and version eligibility."
            )
        subject = {
            "subject_kind": "team",
            "team": team,
            "team_roster_revision": team.roster_revision,
        }
    existing = (
        AssignmentWork.objects.select_for_update()
        .filter(assignment_version=version, state="active", **subject)
        .first()
    )
    if existing is not None:
        project = Project.objects.select_for_update().get(id=existing.project_id)
        if project.owner_id not in {member.user_id for member in members}:
            retire_work(assignment, "project_unavailable", id=existing.id)
        else:
            raise AssignmentConflict(
                {
                    "code": "work_already_exists",
                    "detail": "This subject already has work for this version. Open that retained work instead.",
                    "work_id": str(existing.id),
                }
            )
    if assignment.works.count() >= MAX_WORK:
        raise AssignmentCapacity(
            "assignment_work_capacity",
            "This assignment has reached its 200 lifetime work limit.",
        )
    starter = version.starter_revision
    starter.runtime_profile = RuntimeProfile.objects.select_for_update().get(
        id=version.runtime_profile_id
    )
    verify_runtime(starter)
    if (
        version.starter_manifest_sha256 != starter.manifest_sha256
        or version.runtime_identity != starter.runtime_identity
        or version.runtime_manifest != starter.runtime_manifest
        or version.helper_release != starter.helper_release
        or version.helper_release != HELPER_RELEASE
    ):
        raise AssignmentConflict(
            "This published starter's identities do not match its frozen bundle."
        )
    manifest = revision_manifest(starter)
    current = current_member(user, session_key, assignment)
    if not all(
        active_verified(assignment.workspace, member.user_id) for member in members
    ):
        raise AssignmentConflict(
            "A roster member is no longer an eligible workspace member."
        )
    copied = create_from_manifest(
        assignment.workspace,
        current,
        name=project_name,
        profile=starter.runtime_profile,
        manifest=manifest,
    )
    if team is not None:
        ProjectAccess.objects.bulk_create(
            [
                ProjectAccess(project=copied, user=member.user, role="editor")
                for member in members
                if member.user_id != current.id
            ]
        )
    work = AssignmentWork.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        assignment_version=version,
        created_by=current,
        project=copied,
        client_request_id=client_request_id,
        request_sha256=request_digest(
            assignment.id,
            current.id,
            subject_kind=version.submission_mode,
            participation_id=participation.id if team is None else None,
            team_id=team.id if team else None,
            **common,
        ),
        **subject,
    )
    AssignmentWorkMember.objects.bulk_create(
        [
            AssignmentWorkMember(
                work=work,
                assignment=assignment,
                participation=member,
                user=member.user,
                display_name=public_display_name(member.user.display_name),
                participation_revision=member.revision,
                consent_roster_revision=team.roster_revision if team else None,
                source_role_at_creation="owner"
                if member.user_id == current.id
                else "editor",
            )
            for member in members
        ]
    )
    # This runs after file/grant/event preparation as well as after runtime-row waits.
    current_member(user, session_key, assignment)
    if not all(
        active_verified(assignment.workspace, member.user_id) for member in members
    ):
        raise AssignmentConflict(
            "A roster member is no longer eligible. No work was created."
        )
    return work, True

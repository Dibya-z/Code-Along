import uuid
from typing import Any, cast

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema, extend_schema_view
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.common.api import BodySerializer, PageSerializer, actor
from code_along.common.schema_helpers import endpoint
from code_along.events.contracts import utc
from code_along.projects.policies import project_role, visible_projects
from code_along.workspaces.policies import require_membership

from . import participation_dto as dto
from . import participation_services as participation
from . import team_services as teams
from . import work_services as works
from .api import AssignmentView
from .dto import AssignmentRevision
from .models import (
    Assignment,
    AssignmentParticipation,
    AssignmentTeam,
    AssignmentVersion,
    AssignmentWork,
)
from .policies import is_teacher, require_assignment_teacher
from .selectors import public_versions


def values(
    request: Request, schema: type[BodySerializer], *, query: bool = False
) -> dict[str, Any]:
    parsed = schema(data=request.query_params.dict() if query else request.data)
    parsed.is_valid(raise_exception=True)
    return cast(dict[str, Any], parsed.validated_data)


def assignment_scope(assignment_id: uuid.UUID, user: User) -> Assignment:
    assignment = get_object_or_404(
        Assignment.objects.select_related("workspace", "current_version"),
        id=assignment_id,
    )
    require_membership(assignment.workspace, user)
    return assignment


def user_data(user: User) -> dict[str, str]:
    return {"id": str(user.id), "display_name": public_display_name(user.display_name)}


def participation_data(record: AssignmentParticipation, user: User) -> dict[str, Any]:
    expired = record.state == "invited" and record.invite_expires_at <= timezone.now()
    offer = None
    if record.team_id is not None:
        team = record.team
        assert team is not None
        offer = {
            "team_id": str(team.id),
            "name": team.name,
            "roster_revision": team.roster_revision,
            "expires_at": utc(record.team_offer_expires_at)
            if record.team_offer_expires_at
            else None,
            "consented_revision": record.team_consent_revision,
            "consented_at": utc(record.team_consented_at)
            if record.team_consented_at
            else None,
        }
    return {
        "id": str(record.id),
        "assignment_id": str(record.assignment_id),
        "user": user_data(record.user),
        "state": record.state,
        "effective_state": "expired" if expired else record.state,
        "revision": record.revision,
        "invited_at": utc(record.invited_at),
        "invite_expires_at": utc(record.invite_expires_at),
        "accepted_at": utc(record.accepted_at) if record.accepted_at else None,
        "ended_at": utc(record.ended_at) if record.ended_at else None,
        "team_offer": offer,
        "can_accept": record.user_id == user.id
        and record.state == "invited"
        and not expired
        and record.assignment.archived_at is None
        and record.workspace.archived_at is None,
        "can_withdraw": record.user_id == user.id and record.state == "accepted",
    }


def selected_version(
    assignment: Assignment, params: dict[str, Any]
) -> AssignmentVersion | None:
    identifier = params.get("assignment_version_id")
    return (
        get_object_or_404(public_versions(), assignment=assignment, id=identifier)
        if identifier is not None
        else None
    )


def team_data(
    team: AssignmentTeam, version: AssignmentVersion | None = None
) -> dict[str, Any]:
    members = teams.roster(team)
    eligibility = None
    if version is not None:
        eligible = teams.version_eligible(version, members)
        eligibility = {
            "assignment_version_id": str(version.id),
            "submission_mode": version.submission_mode,
            "member_count": len(members),
            "max_team_size": version.max_team_size,
            "eligible": eligible,
            "reason": None
            if eligible
            else "mode_mismatch"
            if version.submission_mode != "team"
            else "team_size",
        }
    return {
        "id": str(team.id),
        "assignment_id": str(team.assignment_id),
        "name": team.name,
        "revision": team.revision,
        "roster_revision": team.roster_revision,
        "approved_roster_revision": team.approved_roster_revision,
        "archived": team.archived_at is not None,
        "consent_ready": teams.consent_ready(team, members),
        "version_eligibility": eligibility,
        "members": [
            {
                "participation_id": str(member.id),
                "user": user_data(member.user),
                "consented": member.team_consent_revision == team.roster_revision,
            }
            for member in members
        ],
        "created_at": utc(team.created_at),
        "updated_at": utc(team.updated_at),
    }


def work_data(work: AssignmentWork, user: User) -> dict[str, Any]:
    # Teaching/learning metadata never authorizes a live-project read.
    project = (
        visible_projects(user)
        .filter(id=work.project_id)
        .select_related("workspace")
        .first()
    )
    projection = None
    if project is not None:
        projection = {
            "id": str(project.id),
            "name": project.name,
            "role": project_role(project, user),
        }
        work.project = project
    return {
        "id": str(work.id),
        "assignment_id": str(work.assignment_id),
        "assignment_version_id": str(work.assignment_version_id),
        "subject_kind": work.subject_kind,
        "team_id": str(work.team_id) if work.team_id else None,
        "team_roster_revision": work.team_roster_revision,
        "state": work.state,
        "retired_reason": work.retired_reason,
        "created_at": utc(work.created_at),
        "can_continue": works.can_continue(
            work, user, project_visible=project is not None
        ),
        "project": projection,
    }


@extend_schema_view(
    get=extend_schema(
        operation_id="list_assignment_participations",
        parameters=[PageSerializer],
        responses={200: dto.ParticipationPage},
    ),
    post=endpoint(
        "offer_assignment_participation",
        dto.Participation,
        request=dto.ParticipationOffer,
        status=201,
    ),
)
class ParticipationListView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        user = actor(request)
        assignment = assignment_scope(assignment_id, user)
        require_assignment_teacher(assignment.workspace, user)
        params = values(request, PageSerializer, query=True)
        records = assignment.participations.select_related(
            "user", "assignment", "workspace", "team"
        )
        return Response(
            {
                "items": [
                    participation_data(record, user)
                    for record in records[
                        params["offset"] : params["offset"] + params["limit"]
                    ]
                ],
                "count": records.count(),
            }
        )

    def post(self, request: Request, assignment_id: uuid.UUID) -> Response:
        record, created = participation.offer_participation(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **values(request, dto.ParticipationOffer),
        )
        return Response(
            participation_data(record, actor(request)), status=201 if created else 200
        )


@extend_schema_view(get=endpoint("get_own_assignment_participation", dto.Participation))
class OwnParticipationView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        user = actor(request)
        assignment = assignment_scope(assignment_id, user)
        return Response(
            participation_data(participation.own_participation(assignment, user), user)
        )


class ParticipationActionView(AssignmentView):
    action = "accept"

    def post(
        self,
        request: Request,
        assignment_id: uuid.UUID,
        participation_id: uuid.UUID | None = None,
    ) -> Response:
        record = participation.transition_participation(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            action=self.action,
            participation_id=participation_id,
            **values(request, AssignmentRevision),
        )
        return Response(participation_data(record, actor(request)))


@extend_schema_view(
    post=endpoint(
        "accept_assignment_participation", dto.Participation, request=AssignmentRevision
    )
)
class AcceptParticipationView(ParticipationActionView):
    action = "accept"


@extend_schema_view(
    post=endpoint(
        "decline_assignment_participation",
        dto.Participation,
        request=AssignmentRevision,
    )
)
class DeclineParticipationView(ParticipationActionView):
    action = "decline"


@extend_schema_view(
    post=endpoint(
        "withdraw_assignment_participation",
        dto.Participation,
        request=AssignmentRevision,
    )
)
class WithdrawParticipationView(ParticipationActionView):
    action = "withdraw"


@extend_schema_view(
    post=endpoint(
        "revoke_assignment_participation", dto.Participation, request=AssignmentRevision
    )
)
class RevokeParticipationView(ParticipationActionView):
    action = "revoke"


@extend_schema_view(
    get=extend_schema(
        operation_id="list_assignment_teams",
        parameters=[dto.TeamListQuery],
        responses={200: dto.TeamPage},
    ),
    post=endpoint(
        "create_assignment_team", dto.Team, request=dto.TeamCreate, status=201
    ),
)
class TeamListView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        assignment = assignment_scope(assignment_id, actor(request))
        require_assignment_teacher(assignment.workspace, actor(request))
        params = values(request, dto.TeamListQuery, query=True)
        version = selected_version(assignment, params)
        records = assignment.teams.select_related("workspace", "assignment")
        return Response(
            {
                "items": [
                    team_data(team, version)
                    for team in records[
                        params["offset"] : params["offset"] + params["limit"]
                    ]
                ],
                "count": records.count(),
            }
        )

    def post(self, request: Request, assignment_id: uuid.UUID) -> Response:
        team = teams.create_team(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **values(request, dto.TeamCreate),
        )
        return Response(team_data(team), status=201)


@extend_schema_view(
    get=extend_schema(
        operation_id="get_assignment_team",
        parameters=[dto.TeamVersionQuery],
        responses={200: dto.Team},
    ),
    patch=endpoint("update_assignment_team", dto.Team, request=dto.TeamPatch),
)
class TeamDetailView(AssignmentView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, team_id: uuid.UUID
    ) -> Response:
        user = actor(request)
        assignment = assignment_scope(assignment_id, user)
        team = get_object_or_404(AssignmentTeam, assignment=assignment, id=team_id)
        if (
            not is_teacher(assignment.workspace, user)
            and not team.participations.filter(user=user, state="accepted").exists()
        ):
            raise NotFound("Team unavailable.")
        return Response(
            team_data(
                team,
                selected_version(
                    assignment, values(request, dto.TeamVersionQuery, query=True)
                ),
            )
        )

    def patch(
        self, request: Request, assignment_id: uuid.UUID, team_id: uuid.UUID
    ) -> Response:
        return Response(
            team_data(
                teams.update_team(
                    actor(request),
                    request._request.session.session_key,
                    assignment_id,
                    team_id,
                    **values(request, dto.TeamPatch),
                )
            )
        )


@extend_schema_view(
    post=endpoint("offer_assignment_team_member", dto.Team, request=dto.TeamMemberOffer)
)
class TeamMembersView(AssignmentView):
    def post(
        self, request: Request, assignment_id: uuid.UUID, team_id: uuid.UUID
    ) -> Response:
        return Response(
            team_data(
                teams.offer_team_member(
                    actor(request),
                    request._request.session.session_key,
                    assignment_id,
                    team_id,
                    **values(request, dto.TeamMemberOffer),
                )
            )
        )


@extend_schema_view(
    delete=extend_schema(
        operation_id="remove_assignment_team_member",
        parameters=[dto.TeamMemberRemove],
        responses={200: dto.Team},
    )
)
class TeamMemberDetailView(AssignmentView):
    def delete(
        self,
        request: Request,
        assignment_id: uuid.UUID,
        team_id: uuid.UUID,
        participation_id: uuid.UUID,
    ) -> Response:
        return Response(
            team_data(
                teams.remove_team_member(
                    actor(request),
                    request._request.session.session_key,
                    assignment_id,
                    team_id,
                    participation_id,
                    **values(request, dto.TeamMemberRemove, query=True),
                )
            )
        )


@extend_schema_view(
    post=endpoint("approve_assignment_team", dto.Team, request=dto.TeamApproval)
)
class TeamApprovalView(AssignmentView):
    def post(
        self, request: Request, assignment_id: uuid.UUID, team_id: uuid.UUID
    ) -> Response:
        return Response(
            team_data(
                teams.approve_team(
                    actor(request),
                    request._request.session.session_key,
                    assignment_id,
                    team_id,
                    **values(request, dto.TeamApproval),
                )
            )
        )


@extend_schema_view(
    post=endpoint("consent_assignment_team", dto.Participation, request=dto.TeamConsent)
)
class TeamConsentView(AssignmentView):
    def post(self, request: Request, assignment_id: uuid.UUID) -> Response:
        record = teams.consent_team(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **values(request, dto.TeamConsent),
        )
        return Response(participation_data(record, actor(request)))


@extend_schema_view(
    get=extend_schema(
        operation_id="list_assignment_work",
        parameters=[dto.WorkListQuery],
        responses={200: dto.WorkPage},
    ),
    post=endpoint(
        "create_assignment_work", dto.Work, request=dto.WorkCreate, status=201
    ),
)
class WorkListView(AssignmentView):
    def get(self, request: Request, assignment_id: uuid.UUID) -> Response:
        user = actor(request)
        assignment = assignment_scope(assignment_id, user)
        params = values(request, dto.WorkListQuery, query=True)
        records = AssignmentWork.objects.filter(assignment=assignment).select_related(
            "assignment", "workspace", "assignment_version", "participation", "team"
        )
        if params["mine"] == "true":
            records = records.filter(members__user=user)
        else:
            require_assignment_teacher(assignment.workspace, user)
        if params["include_retired"] == "false":
            records = records.filter(state="active")
        return Response(
            {
                "items": [
                    work_data(record, user)
                    for record in records[
                        params["offset"] : params["offset"] + params["limit"]
                    ]
                ],
                "count": records.count(),
            }
        )

    def post(self, request: Request, assignment_id: uuid.UUID) -> Response:
        record, created = works.create_work(
            actor(request),
            request._request.session.session_key,
            assignment_id,
            **values(request, dto.WorkCreate),
        )
        return Response(
            work_data(record, actor(request)), status=201 if created else 200
        )


@extend_schema_view(get=endpoint("get_assignment_work", dto.Work))
class WorkDetailView(AssignmentView):
    def get(
        self, request: Request, assignment_id: uuid.UUID, work_id: uuid.UUID
    ) -> Response:
        user = actor(request)
        assignment = assignment_scope(assignment_id, user)
        return Response(work_data(works.readable_work(assignment, work_id, user), user))

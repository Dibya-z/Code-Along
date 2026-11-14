from django.urls import path

from . import api
from . import participation_api as participation

urlpatterns = [
    path(
        "<uuid:assignment_id>/participations/",
        participation.ParticipationListView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participation/",
        participation.OwnParticipationView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participation/accept/",
        participation.AcceptParticipationView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participation/decline/",
        participation.DeclineParticipationView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participation/withdraw/",
        participation.WithdrawParticipationView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participations/<uuid:participation_id>/revoke/",
        participation.RevokeParticipationView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/participation/team-consent/",
        participation.TeamConsentView.as_view(),
    ),
    path("<uuid:assignment_id>/teams/", participation.TeamListView.as_view()),
    path(
        "<uuid:assignment_id>/teams/<uuid:team_id>/",
        participation.TeamDetailView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/teams/<uuid:team_id>/members/",
        participation.TeamMembersView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/teams/<uuid:team_id>/members/<uuid:participation_id>/",
        participation.TeamMemberDetailView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/teams/<uuid:team_id>/approval/",
        participation.TeamApprovalView.as_view(),
    ),
    path("<uuid:assignment_id>/works/", participation.WorkListView.as_view()),
    path(
        "<uuid:assignment_id>/works/<uuid:work_id>/",
        participation.WorkDetailView.as_view(),
    ),
    path("<uuid:assignment_id>/", api.AssignmentDetailView.as_view()),
    path("<uuid:assignment_id>/draft/", api.AssignmentDraftView.as_view()),
    path("<uuid:assignment_id>/versions/", api.AssignmentVersionListView.as_view()),
    path(
        "<uuid:assignment_id>/versions/<uuid:version_id>/",
        api.AssignmentVersionDetailView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/versions/<uuid:version_id>/starter/",
        api.AssignmentStarterView.as_view(),
    ),
]

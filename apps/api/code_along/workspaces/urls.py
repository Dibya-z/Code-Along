from django.urls import path

from code_along.projects.api import ProjectListView

from . import api, invitation_api

urlpatterns = [
    path("<uuid:workspace_id>/projects/", ProjectListView.as_view()),
    path(
        "<uuid:workspace_id>/invitations/", invitation_api.InvitationListView.as_view()
    ),
    path(
        "<uuid:workspace_id>/invitations/<uuid:invitation_id>/",
        invitation_api.InvitationRevokeView.as_view(),
    ),
    path("", api.WorkspaceListView.as_view()),
    path("<uuid:workspace_id>/", api.WorkspaceDetailView.as_view()),
    path("<uuid:workspace_id>/members/", api.MemberListView.as_view()),
    path("<uuid:workspace_id>/members/<uuid:user_id>/", api.MemberDetailView.as_view()),
    path("<uuid:workspace_id>/ownership/", api.OwnershipView.as_view()),
]

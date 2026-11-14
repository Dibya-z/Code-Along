from django.urls import path

from code_along.chat.api import MessageListView
from code_along.events.api import ProjectEventListView

from . import api, revision_api, share_api, sharing

urlpatterns = [
    path("<uuid:project_id>/events/", ProjectEventListView.as_view()),
    path("<uuid:project_id>/chat/messages/", MessageListView.as_view()),
    path("<uuid:project_id>/revisions/", revision_api.RevisionListView.as_view()),
    path(
        "<uuid:project_id>/revisions/<uuid:revision_id>/",
        revision_api.RevisionDetailView.as_view(),
    ),
    path(
        "<uuid:project_id>/revisions/<uuid:revision_id>/copies/",
        revision_api.RevisionCopyView.as_view(),
    ),
    path("<uuid:project_id>/shares/", share_api.ShareListView.as_view()),
    path(
        "<uuid:project_id>/shares/<uuid:share_id>/", share_api.ShareDetailView.as_view()
    ),
    path("<uuid:project_id>/invitations/", sharing.ProjectInvitationListView.as_view()),
    path(
        "<uuid:project_id>/invitations/<uuid:invitation_id>/",
        sharing.ProjectInvitationRevokeView.as_view(),
    ),
    path("<uuid:project_id>/", api.ProjectDetailView.as_view()),
    path("<uuid:project_id>/files/", api.FileListView.as_view()),
    path("<uuid:project_id>/files/<uuid:file_id>/", api.FileDetailView.as_view()),
    path("<uuid:project_id>/grants/", api.GrantListView.as_view()),
    path("<uuid:project_id>/grants/<uuid:user_id>/", api.GrantDetailView.as_view()),
    path("<uuid:project_id>/ownership/", api.ProjectOwnershipView.as_view()),
]

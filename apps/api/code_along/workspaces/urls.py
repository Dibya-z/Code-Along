from django.urls import path

from . import api

urlpatterns = [
    path("", api.WorkspaceListView.as_view()),
    path("<uuid:workspace_id>/", api.WorkspaceDetailView.as_view()),
    path("<uuid:workspace_id>/members/", api.MemberListView.as_view()),
    path("<uuid:workspace_id>/members/<uuid:user_id>/", api.MemberDetailView.as_view()),
    path("<uuid:workspace_id>/ownership/", api.OwnershipView.as_view()),
]

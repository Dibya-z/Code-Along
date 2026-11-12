from django.urls import path

from . import api

urlpatterns = [
    path("<uuid:project_id>/", api.ProjectDetailView.as_view()),
    path("<uuid:project_id>/files/", api.FileListView.as_view()),
    path("<uuid:project_id>/files/<uuid:file_id>/", api.FileDetailView.as_view()),
    path("<uuid:project_id>/grants/", api.GrantListView.as_view()),
    path("<uuid:project_id>/grants/<uuid:user_id>/", api.GrantDetailView.as_view()),
    path("<uuid:project_id>/ownership/", api.ProjectOwnershipView.as_view()),
]

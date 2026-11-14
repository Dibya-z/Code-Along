from django.urls import path

from . import api

urlpatterns = [
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

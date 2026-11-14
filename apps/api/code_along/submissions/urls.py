from django.urls import path

from .api import AssignmentSubmissionsView, SubmissionDetailView, WorkSubmissionsView

urlpatterns = [
    path(
        "<uuid:assignment_id>/works/<uuid:work_id>/submissions/",
        WorkSubmissionsView.as_view(),
    ),
    path("<uuid:assignment_id>/submissions/", AssignmentSubmissionsView.as_view()),
    path(
        "<uuid:assignment_id>/submissions/<uuid:submission_id>/",
        SubmissionDetailView.as_view(),
    ),
]

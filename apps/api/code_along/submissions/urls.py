from django.urls import path

from .api import AssignmentSubmissionsView, SubmissionDetailView, WorkSubmissionsView
from .feedback_api import (
    FeedbackDraftView,
    FeedbackLatestView,
    FeedbackPublicationsView,
)

urlpatterns = [
    path(
        "<uuid:assignment_id>/submissions/<uuid:submission_id>/feedback/",
        FeedbackLatestView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/submissions/<uuid:submission_id>/feedback/draft/",
        FeedbackDraftView.as_view(),
    ),
    path(
        "<uuid:assignment_id>/submissions/<uuid:submission_id>/feedback/publications/",
        FeedbackPublicationsView.as_view(),
    ),
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

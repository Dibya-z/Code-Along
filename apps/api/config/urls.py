from code_along.accounts.api import CurrentUserView
from code_along.projects.api import RuntimeListView
from code_along.workspaces.invitation_api import (
    InvitationAcceptView,
    InvitationPreviewView,
)
from django.urls import include, path

from .views import csrf_token, liveness, readiness

urlpatterns = [
    path("api/v1/projects/", include("code_along.projects.urls")),
    path("api/v1/runtime-profiles/", RuntimeListView.as_view()),
    path("api/v1/invitations/preview/", InvitationPreviewView.as_view()),
    path("api/v1/invitations/accept/", InvitationAcceptView.as_view()),
    path("api/v1/workspaces/", include("code_along.workspaces.urls")),
    path("api/v1/auth/", include("allauth.headless.urls")),
    path("api/v1/me/", CurrentUserView.as_view(), name="current-user"),
    path("api/v1/csrf/", csrf_token, name="csrf-token"),
    path("health/live/", liveness, name="liveness"),
    path("health/ready/", readiness, name="readiness"),
]
handler404 = "config.views.not_found"
handler500 = "config.views.server_error"

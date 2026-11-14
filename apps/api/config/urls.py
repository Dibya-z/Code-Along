from code_along.accounts.api import CsrfTokenView, CurrentUserView
from code_along.collaboration.api import TicketView
from code_along.learning.api import AssignmentListView
from code_along.projects.api import RuntimeListView
from code_along.projects.share_api import ShareResolveView
from code_along.workspaces.invitation_api import (
    InvitationAcceptView,
    InvitationPreviewView,
)
from django.urls import include, path

from .views import liveness, readiness

urlpatterns = [
    path(
        "api/v1/workspaces/<uuid:workspace_id>/assignments/",
        AssignmentListView.as_view(),
    ),
    path("api/v1/assignments/", include("code_along.learning.urls")),
    path("api/v1/shares/resolve/", ShareResolveView.as_view()),
    path("internal/v1/collaboration/", include("code_along.collaboration.urls")),
    path(
        "api/v1/projects/<uuid:project_id>/documents/<uuid:document_id>/ticket/",
        TicketView.as_view(),
    ),
    path("api/v1/projects/", include("code_along.projects.urls")),
    path("api/v1/runtime-profiles/", RuntimeListView.as_view()),
    path("api/v1/invitations/preview/", InvitationPreviewView.as_view()),
    path("api/v1/invitations/accept/", InvitationAcceptView.as_view()),
    path("api/v1/workspaces/", include("code_along.workspaces.urls")),
    path("api/v1/auth/", include("allauth.headless.urls")),
    path("api/v1/me/", CurrentUserView.as_view(), name="current-user"),
    path("api/v1/csrf/", CsrfTokenView.as_view(), name="csrf-token"),
    path("health/live/", liveness, name="liveness"),
    path("health/ready/", readiness, name="readiness"),
]
handler404 = "config.views.not_found"
handler500 = "config.views.server_error"

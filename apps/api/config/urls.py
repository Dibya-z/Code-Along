from django.urls import path

from .views import csrf_token, liveness, readiness

urlpatterns = [
    path("api/v1/csrf/", csrf_token, name="csrf-token"),
    path("health/live/", liveness, name="liveness"),
    path("health/ready/", readiness, name="readiness"),
]
handler404 = "config.views.not_found"
handler500 = "config.views.server_error"

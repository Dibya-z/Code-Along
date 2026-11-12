from django.urls import path

from .views import liveness, readiness

urlpatterns = [
    path("health/live/", liveness, name="liveness"),
    path("health/ready/", readiness, name="readiness"),
]
handler404 = "config.views.not_found"
handler500 = "config.views.server_error"

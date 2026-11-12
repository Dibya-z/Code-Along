from django.urls import path

from .views import liveness

urlpatterns = [path("health/live/", liveness, name="liveness")]
handler404 = "config.views.not_found"
handler500 = "config.views.server_error"

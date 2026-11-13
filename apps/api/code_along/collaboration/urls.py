from django.urls import path

from .api import PrivateAdmissionView, RenewView

urlpatterns = [
    path("consume/", PrivateAdmissionView.as_view()),
    path("renew/", RenewView.as_view()),
]

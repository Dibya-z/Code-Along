from __future__ import annotations

from typing import TYPE_CHECKING

from allauth.account.models import EmailAddress
from rest_framework.permissions import BasePermission
from rest_framework.request import Request

if TYPE_CHECKING:
    from rest_framework.views import APIView

from .models import User


class VerifiedAccount(BasePermission):
    message = "Sign in with a verified account to continue."

    def has_permission(self, request: Request, view: APIView) -> bool:
        user = request.user
        return (
            isinstance(user, User)
            and user.is_active
            and EmailAddress.objects.filter(
                user=user, email=user.email, verified=True, primary=True
            ).exists()
        )

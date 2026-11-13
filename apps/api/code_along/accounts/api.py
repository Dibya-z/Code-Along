from django.middleware.csrf import get_token
from drf_spectacular.utils import extend_schema_view
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from code_along.common import schemas as dto
from code_along.common.schema_helpers import endpoint

from .models import User
from .permissions import VerifiedAccount


@extend_schema_view(get=endpoint("get_current_user", dto.CurrentUserOutput))
class CurrentUserView(APIView):
    permission_classes = [VerifiedAccount]

    def get(self, request: Request) -> Response:
        user = request.user
        assert isinstance(user, User)
        return Response(
            {
                "id": str(user.id),
                "email": user.email,
                "display_name": user.display_name,
            },
            headers={"Cache-Control": "no-store"},
        )


@extend_schema_view(get=endpoint("get_csrf_token", dto.CsrfOutput))
class CsrfTokenView(APIView):
    permission_classes = [AllowAny]
    authentication_classes: list[type] = []

    def get(self, request: Request) -> Response:
        return Response({"csrfToken": get_token(request._request)})

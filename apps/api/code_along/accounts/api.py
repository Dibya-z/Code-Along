from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import User
from .permissions import VerifiedAccount


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

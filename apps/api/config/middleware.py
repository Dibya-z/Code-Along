from collections.abc import Callable

from django.http import HttpRequest, HttpResponse
from django.utils.cache import patch_vary_headers


class PrivateApiMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        if request.path.startswith("/api/"):
            response["Cache-Control"] = "no-store"
            patch_vary_headers(response, ("Cookie",))
        return response

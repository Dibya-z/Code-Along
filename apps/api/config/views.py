from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_safe


@require_safe
def liveness(request: HttpRequest) -> JsonResponse:
    """Process liveness only; no database, cache, credentials or user state."""
    response = JsonResponse({"status": "ok"})
    response["Cache-Control"] = "no-store"
    return response


def not_found(request: HttpRequest, exception: Exception) -> JsonResponse:
    return JsonResponse({"error": "not_found"}, status=404)


def server_error(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"error": "internal_error"}, status=500)

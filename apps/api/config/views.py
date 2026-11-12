from django.conf import settings
from django.db import connection
from django.http import HttpRequest, JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.http import require_safe
from redis import Redis


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


@require_safe
def csrf_token(request: HttpRequest) -> JsonResponse:
    return JsonResponse(
        {"csrfToken": get_token(request)}, headers={"Cache-Control": "no-store"}
    )


@require_safe
def readiness(request: HttpRequest) -> JsonResponse:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        url = settings.REDIS_CONNECTION_SECRET
        if not url:
            raise RuntimeError
        with Redis.from_url(url, socket_connect_timeout=1, socket_timeout=1) as client:
            if not client.ping():
                raise RuntimeError
    except Exception:
        # Connection failures must never reveal credentials, hosts or SQL.
        return JsonResponse(
            {"status": "unavailable"}, status=503, headers={"Cache-Control": "no-store"}
        )
    return JsonResponse({"status": "ready"}, headers={"Cache-Control": "no-store"})

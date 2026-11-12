import asyncio

import pytest
from asgiref.testing import ApplicationCommunicator
from django.test import Client, RequestFactory

from config.asgi import application
from config.views import server_error


def test_liveness_needs_no_database_and_has_no_environment_details(
    client: Client,
) -> None:
    response = client.get("/health/live/")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response["Cache-Control"] == "no-store"
    assert response["X-Content-Type-Options"] == "nosniff"
    assert response["X-Frame-Options"] == "DENY"
    assert not response.cookies


def test_liveness_head_and_unsafe_method(client: Client) -> None:
    assert client.head("/health/live/").status_code == 200
    assert client.post("/health/live/", data={}).status_code == 405


def test_csrf_middleware_remains_enabled() -> None:
    client = Client(enforce_csrf_checks=True)
    assert client.post("/health/live/").status_code == 403


def test_invalid_hosts_are_rejected(client: Client) -> None:
    assert client.get("/health/live/", HTTP_HOST="attacker.invalid").status_code == 400


@pytest.mark.parametrize("path", ["/", "/admin/", "/api/v1/auth/login/", "/unknown/"])
def test_unimplemented_routes_are_not_advertised(client: Client, path: str) -> None:
    response = client.get(path)
    assert response.status_code == 404
    assert response.json() == {"error": "not_found"}


def test_generic_server_error_contains_no_traceback() -> None:
    response = server_error(RequestFactory().get("/"))
    assert response.status_code == 500
    assert response.content == b'{"error": "internal_error"}'


def test_asgi_serves_http_and_denies_unimplemented_websockets() -> None:
    async def check() -> None:
        http = ApplicationCommunicator(
            application,
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/health/live/",
                "raw_path": b"/health/live/",
                "query_string": b"",
                "headers": [(b"host", b"testserver")],
            },
        )
        await http.send_input({"type": "http.request", "body": b"", "more_body": False})
        start = await http.receive_output(timeout=2)
        assert start["type"] == "http.response.start" and start["status"] == 200
        body = await http.receive_output(timeout=2)
        assert body["body"] == b'{"status": "ok"}'
        await http.wait(timeout=2)
        websocket = ApplicationCommunicator(
            application, {"type": "websocket", "path": "/events/"}
        )
        await websocket.send_input({"type": "websocket.connect"})
        assert await websocket.receive_output(timeout=2) == {
            "type": "websocket.close",
            "code": 4404,
            "reason": "not_implemented",
        }
        await websocket.wait(timeout=2)

    asyncio.run(check())

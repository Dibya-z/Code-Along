from typing import Any

from django.conf import settings


class ExactOrigin:
    def __init__(self, application: Any, path: str = "/events") -> None:
        self.application = application
        self.path = path

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        origins = [
            value
            for name, value in scope.get("headers", [])
            if name.lower() == b"origin"
        ]
        if (
            scope.get("path") != self.path
            or scope.get("query_string", b"")
            or origins != [settings.PUBLIC_APP_ORIGIN.encode("ascii")]
        ):
            event = await receive()
            if event["type"] == "websocket.connect":
                await send(
                    {"type": "websocket.close", "code": 4403, "reason": "unauthorized"}
                )
            return
        await self.application(scope, receive, send)


class EventRoutes:
    """Exact socket dispatch happens before session middleware/database work."""

    def __init__(self, public: Any, learning: Any) -> None:
        self.routes = {"/events": public, "/events/learning": learning}

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        application = self.routes.get(scope.get("path"))
        if application is None:
            event = await receive()
            if event["type"] == "websocket.connect":
                await send(
                    {"type": "websocket.close", "code": 4403, "reason": "unauthorized"}
                )
            return
        await application(scope, receive, send)

from typing import Any

from django.conf import settings


class ExactOrigin:
    def __init__(self, application: Any) -> None:
        self.application = application

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        origins = [
            value
            for name, value in scope.get("headers", [])
            if name.lower() == b"origin"
        ]
        if (
            scope.get("path") != "/events"
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

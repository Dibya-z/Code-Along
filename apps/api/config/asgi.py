import os
from typing import cast

from asgiref.typing import (
    ASGI3Application,
    ASGIReceiveCallable,
    ASGISendCallable,
    Scope,
)
from channels.routing import ProtocolTypeRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.production")
django_application = get_asgi_application()


async def reject_websocket(
    scope: Scope, receive: ASGIReceiveCallable, send: ASGISendCallable
) -> None:
    # No subscriptions/auth handshake exists yet. Fail closed without accepting.
    event = await receive()
    if event["type"] == "websocket.connect":
        await send(
            {"type": "websocket.close", "code": 4404, "reason": "not_implemented"}
        )


# Channels 4.3 has no annotated constructor; keep the exception at this tested boundary.
_router = ProtocolTypeRouter(
    {"http": django_application, "websocket": reject_websocket}
)
application = cast(ASGI3Application, _router)

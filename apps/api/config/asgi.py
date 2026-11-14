import os
from typing import cast

from asgiref.typing import ASGI3Application
from channels.routing import ProtocolTypeRouter
from channels.sessions import SessionMiddlewareStack
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.production")
django_application = get_asgi_application()

from code_along.events.consumer import ProjectEventsConsumer  # noqa: E402
from code_along.events.routing import ExactOrigin  # noqa: E402

# Channels 4.3 has no annotated constructor; keep the exception at this tested boundary.
# Authentication happens inside the consumer's bounded current-session authority check.
# The standard session stack supplies only the actual cookie-backed framework session.
events_application = SessionMiddlewareStack(  # type: ignore[no-untyped-call]
    ProjectEventsConsumer.as_asgi()  # type: ignore[no-untyped-call]
)
_router = ProtocolTypeRouter(
    {
        "http": django_application,
        "websocket": ExactOrigin(events_application),
    }
)
application = cast(ASGI3Application, _router)

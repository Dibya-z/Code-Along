import asyncio
import json
import time
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from asgiref.testing import ApplicationCommunicator
from channels.layers import get_channel_layer
from config.asgi import application
from django.conf import settings
from django.test import override_settings

from code_along.events.services import session_group
from code_along.learning import event_consumer as consumer
from code_along.learning import event_wire as wire
from code_along.learning.notification_types import (
    LearningAccess,
    LearningDenied,
    LearningHead,
    LearningUnavailable,
    StreamIdentity,
    stream_group,
)
from code_along.learning.tests.test_event_wire import ASSIGNMENT, command

USER = uuid.UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
ACCESS = LearningAccess(
    USER, StreamIdentity(uuid.uuid4(), ASSIGNMENT, uuid.uuid4(), USER, uuid.uuid4())
)
SESSION = "a" * 32
MEMORY_LAYER = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def socket() -> ApplicationCommunicator:
    return ApplicationCommunicator(
        application,
        {
            "type": "websocket",
            "path": "/events/learning",
            "query_string": b"",
            "headers": [
                (b"origin", b"https://testserver"),
                (b"cookie", f"{settings.SESSION_COOKIE_NAME}={SESSION}".encode()),
            ],
        },
    )


async def open_socket(
    ws: ApplicationCommunicator, text: str | None = None
) -> dict[str, Any]:
    await ws.send_input({"type": "websocket.connect"})
    assert (await ws.receive_output(timeout=2))["type"] == "websocket.accept"
    await ws.send_input({"type": "websocket.receive", "text": text or command()})
    return await ws.receive_output(timeout=2)  # type: ignore[no-any-return]


async def disconnect(ws: ApplicationCommunicator) -> None:
    await ws.send_input({"type": "websocket.disconnect", "code": 1000})
    await ws.wait(timeout=2)


@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_exact_asgi_joins_both_private_groups_before_fresh_head_and_pins_identity() -> (
    None
):
    async def check() -> None:
        layer = get_channel_layer()  # type: ignore[no-untyped-call]
        assert layer is not None

        def head(*args: Any, **kwargs: Any) -> LearningHead:
            assert args == (SESSION, ASSIGNMENT, "participant")
            assert kwargs == {"expected_user_id": USER}
            assert layer.groups[stream_group(ACCESS.stream)]
            assert layer.groups[session_group(SESSION)]
            return LearningHead(ACCESS, 7)

        ws = socket()
        with patch.object(consumer, "read_learning_head", side_effect=head):
            first = json.loads((await open_socket(ws))["text"])
            assert first == wire.frame(
                ASSIGNMENT, "participant", "subscribed", 7, refresh_required=True
            )
            await layer.group_send(
                stream_group(ACCESS.stream),
                {
                    "type": "learning.changed",
                    "stream_id": str(ACCESS.stream.id),
                    "generation": 5,
                },
            )
            assert json.loads(
                (await ws.receive_output(timeout=2))["text"]
            ) == wire.frame(
                ASSIGNMENT,
                "participant",
                "learning.changed",
                5,
            )
            await layer.group_send(
                session_group(SESSION), {"type": "access.invalidated"}
            )
            assert (await ws.receive_output(timeout=2))["code"] == 4403
        await disconnect(ws)
        assert not layer.groups

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(
            consumer, "authorize_learning_stream", return_value=ACCESS
        ) as authorize,
    ):
        asyncio.run(check())
    authorize.assert_called_once_with(
        SESSION, ASSIGNMENT, "participant", expected_user_id=USER
    )


@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_fresh_heartbeat_repairs_final_dropped_marker_and_exact_cursor_can_resume() -> (
    None
):
    async def check() -> None:
        ws = socket()
        first = json.loads(
            (await open_socket(ws, command(after_generation="7")))["text"]
        )
        assert not first["refresh_required"] and first["head_generation"] == "7"
        frame = json.loads((await ws.receive_output(timeout=2))["text"])
        assert frame["type"] == "head" and frame["head_generation"] == "8"
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(consumer, "authorize_learning_stream", return_value=ACCESS),
        patch.object(
            consumer,
            "read_learning_head",
            side_effect=[LearningHead(ACCESS, 7), LearningHead(ACCESS, 8)],
        ),
        patch.object(consumer, "HEARTBEAT_SECONDS", 0.05),
    ):
        asyncio.run(check())


@pytest.mark.parametrize(
    "error,code", [(LearningDenied(), 4403), (LearningUnavailable(), 4401)]
)
@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_forward_rechecks_current_authority_before_emitting(
    error: Exception, code: int
) -> None:
    async def check() -> None:
        ws = socket()
        assert "text" in await open_socket(ws)
        layer = get_channel_layer()  # type: ignore[no-untyped-call]
        assert layer is not None
        await layer.group_send(
            stream_group(ACCESS.stream),
            {
                "type": "learning.changed",
                "stream_id": str(ACCESS.stream.id),
                "generation": 1,
            },
        )
        assert (await ws.receive_output(timeout=2))["code"] == code
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(consumer, "authorize_learning_stream", return_value=ACCESS),
        patch.object(
            consumer, "read_learning_head", side_effect=[LearningHead(ACCESS, 1), error]
        ),
    ):
        asyncio.run(check())


@pytest.mark.parametrize(
    "marker",
    [
        {"stream_id": str(uuid.uuid4()), "generation": 1},
        {"stream_id": str(ACCESS.stream.id), "generation": True},
        {"stream_id": str(ACCESS.stream.id), "generation": "1"},
        {"stream_id": str(ACCESS.stream.id), "generation": 0},
        {"stream_id": str(ACCESS.stream.id), "generation": 2},
        {"stream_id": str(ACCESS.stream.id), "generation": 1, "source": "forbidden"},
    ],
)
@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_broker_marker_is_exact_and_validated_against_fresh_immutable_stream(
    marker: dict[str, Any],
) -> None:
    async def check() -> None:
        ws = socket()
        assert "text" in await open_socket(ws)
        layer = get_channel_layer()  # type: ignore[no-untyped-call]
        assert layer is not None
        await layer.group_send(
            stream_group(ACCESS.stream), {"type": "learning.changed", **marker}
        )
        assert (await ws.receive_output(timeout=2))["code"] == 4401
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(consumer, "authorize_learning_stream", return_value=ACCESS),
        patch.object(
            consumer, "read_learning_head", return_value=LearningHead(ACCESS, 1)
        ),
    ):
        asyncio.run(check())


@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_head_identity_change_fails_closed_before_acknowledgement() -> None:
    changed = LearningAccess(
        USER,
        StreamIdentity(
            uuid.uuid4(),
            ASSIGNMENT,
            ACCESS.stream.workspace_id,
            USER,
            ACCESS.stream.participation_id,
        ),
    )

    async def check() -> None:
        ws = socket()
        assert (await open_socket(ws))["code"] == 4403
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(consumer, "authorize_learning_stream", return_value=ACCESS),
        patch.object(
            consumer, "read_learning_head", return_value=LearningHead(changed, 1)
        ),
    ):
        asyncio.run(check())


@pytest.mark.parametrize(
    "message",
    [
        {"bytes": b"binary"},
        {"text": command() + " " * 1024},
        {"text": command().replace('"version": 1', '"version": 1, "version": 1')},
    ],
)
@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_invalid_client_messages_close_without_learning_authorization(
    message: dict[str, Any],
) -> None:
    async def check() -> None:
        ws = socket()
        await ws.send_input({"type": "websocket.connect"})
        assert (await ws.receive_output(timeout=2))["type"] == "websocket.accept"
        await ws.send_input({"type": "websocket.receive", **message})
        assert (await ws.receive_output(timeout=2))["code"] == 4400
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(consumer, "authorize_learning_stream") as authorize,
    ):
        asyncio.run(check())
    authorize.assert_not_called()


def test_late_authorization_cannot_extend_old_deadline_even_if_another_check_refreshed_it() -> (
    None
):
    async def check() -> None:
        ws = consumer.LearningConsumer()  # type: ignore[no-untyped-call]
        ws.closed, ws.deadline = False, 2
        current = [1.0]

        async def late(*args: Any, **kwargs: Any) -> int:
            current[0] = 3
            ws.deadline = 100
            return 1

        with (
            patch.object(
                consumer, "time", SimpleNamespace(monotonic=lambda: current[0])
            ),
            patch.object(consumer, "database_sync_to_async", return_value=late),
            pytest.raises(TimeoutError),
        ):
            await ws.checked(lambda: 1)

    asyncio.run(check())


def test_authorization_timeout_cancels_actual_await() -> None:
    async def check() -> None:
        ws = consumer.LearningConsumer()  # type: ignore[no-untyped-call]
        ws.closed, ws.deadline = False, time.monotonic() + 30
        cancelled = []

        async def blocked() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        with (
            patch.object(consumer, "AUTHORITY_TIMEOUT", 0.01),
            patch.object(consumer, "database_sync_to_async", return_value=blocked),
            pytest.raises(TimeoutError),
        ):
            await ws.checked(lambda: None)
        assert cancelled == [True]

    asyncio.run(check())


@override_settings(CHANNEL_LAYERS=MEMORY_LAYER)
def test_second_subscription_is_rejected_without_a_second_authorization() -> None:
    async def check() -> None:
        ws = socket()
        assert "text" in await open_socket(ws)
        await ws.send_input({"type": "websocket.receive", "text": command()})
        assert (await ws.receive_output(timeout=2))["code"] == 4400
        await disconnect(ws)

    with (
        patch.object(consumer, "_principal", return_value=USER),
        patch.object(
            consumer, "authorize_learning_stream", return_value=ACCESS
        ) as authorize,
        patch.object(
            consumer, "read_learning_head", return_value=LearningHead(ACCESS, 1)
        ),
    ):
        asyncio.run(check())
    authorize.assert_called_once()

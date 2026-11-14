"""Actual framework session and durable-head integration through the exact ASGI route."""

import asyncio
import json
import os
import uuid
from typing import Any
from unittest.mock import patch

import pytest
from allauth.account.models import EmailAddress
from asgiref.testing import ApplicationCommunicator
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from config.asgi import application
from django.conf import settings
from django.contrib.sessions.models import Session
from django.test import override_settings

from code_along.events import dispatcher
from code_along.events.services import session_group
from code_along.learning import event_consumer
from code_along.learning.event_wire import envelope
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    LearningNotificationStream,
)
from code_along.learning.notification_access import read_learning_head
from code_along.learning.notification_types import Audience, stream_group
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db(transaction=True)]


def layer_settings() -> dict[str, Any]:
    # Root's serialized real Redis gate supplies its owned disposable listener.
    redis = os.environ.get("CODE_ALONG_TEST_REDIS_URL")
    if redis:
        return {
            "default": {
                "BACKEND": "channels_redis.core.RedisChannelLayer",
                "CONFIG": {
                    "hosts": [redis],
                    "prefix": f"learning-proof-{uuid.uuid4().hex}",
                },
            }
        }
    return {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}


def fixture(audience: Audience) -> tuple[Assignment, LearningNotificationStream, str]:
    user = person("socket-principal")
    workspace = workspaces.create_workspace(user, "Private socket fixture")
    assignment = Assignment.objects.create(
        workspace=workspace, created_by=user, draft_title="Private learning"
    )
    participation = None
    if audience == "participant":
        # An ended lifetime participant retains their own history and needs no Source grant.
        from django.utils import timezone

        participation = AssignmentParticipation.objects.create(
            assignment=assignment,
            workspace=workspace,
            user=user,
            invited_by=user,
            state="declined",
            ended_at=timezone.now(),
        )
    stream = LearningNotificationStream.objects.create(
        assignment=assignment,
        workspace=workspace,
        audience_user=user if participation else None,
        participation=participation,
        head_generation=1,
    )
    key = signed_in(user).session.session_key
    assert key
    return assignment, stream, key


def socket(key: str) -> ApplicationCommunicator:
    return ApplicationCommunicator(
        application,
        {
            "type": "websocket",
            "path": "/events/learning",
            "query_string": b"",
            "headers": [
                (b"origin", b"https://testserver"),
                (b"cookie", f"{settings.SESSION_COOKIE_NAME}={key}".encode()),
            ],
        },
    )


async def subscribe(
    ws: ApplicationCommunicator, assignment: Assignment, audience: Audience
) -> dict[str, Any]:
    await ws.send_input({"type": "websocket.connect"})
    assert (await ws.receive_output(timeout=3))["type"] == "websocket.accept"
    await ws.send_input(
        {
            "type": "websocket.receive",
            "text": json.dumps(
                {
                    **envelope(assignment.id, audience),
                    "type": "subscribe",
                    "after_generation": None,
                }
            ),
        }
    )
    return await ws.receive_output(timeout=3)  # type: ignore[no-any-return]


async def disconnect(ws: ApplicationCommunicator) -> None:
    await ws.send_input({"type": "websocket.disconnect", "code": 1000})
    await ws.wait(timeout=3)


@pytest.mark.parametrize("audience", ["teaching", "participant"])
def test_real_session_dispatch_and_final_drop_head_repair(audience: Audience) -> None:
    assignment, stream, key = fixture(audience)

    async def check() -> None:
        ws = socket(key)
        first = json.loads((await subscribe(ws, assignment, audience))["text"])
        assert first["head_generation"] == "1" and first["refresh_required"]
        counts = await database_sync_to_async(dispatcher.dispatch_batch)()
        assert counts.published == 1
        for _ in range(20):
            changed = json.loads((await ws.receive_output(timeout=3))["text"])
            if changed["type"] == "learning.changed":
                break
        else:
            raise AssertionError("committed learning generation was not dispatched")
        assert changed == {
            **envelope(assignment.id, audience),
            "type": "learning.changed",
            "head_generation": "1",
        }

        # A final committed change with no broker publication must still be discoverable.
        def final_change() -> None:
            LearningNotificationStream.objects.filter(id=stream.id).update(
                head_generation=2
            )

        await database_sync_to_async(final_change)()
        for _ in range(20):
            repaired = json.loads((await ws.receive_output(timeout=3))["text"])
            if repaired["type"] == "head" and repaired["head_generation"] == "2":
                break
        else:
            raise AssertionError("final dropped learning generation was not repaired")
        layer = get_channel_layer()  # type: ignore[no-untyped-call]
        assert layer is not None
        await layer.group_send(session_group(key), {"type": "access.invalidated"})
        assert (await ws.receive_output(timeout=3))["code"] == 4403
        await disconnect(ws)
        if os.environ.get("CODE_ALONG_TEST_REDIS_URL"):
            await layer.close_pools()

    with (
        override_settings(CHANNEL_LAYERS=layer_settings()),
        patch.object(event_consumer, "HEARTBEAT_SECONDS", 0.3),
    ):
        asyncio.run(check())


@pytest.mark.parametrize(
    "denial",
    [
        "password",
        "verification",
        "inactive",
        "membership",
        "role",
        "logout",
        "replacement",
    ],
)
def test_actual_session_and_current_authority_are_rechecked_before_forward(
    denial: str,
) -> None:
    assignment, stream, key = fixture("teaching")
    user = assignment.created_by
    replacement = person("replacement") if denial == "replacement" else None
    replacement_session = signed_in(replacement).session if replacement else None

    def revoke() -> None:
        if denial == "password":
            user.set_password("different-session-authority-84!")
            user.save(update_fields=["password"])
        elif denial == "verification":
            EmailAddress.objects.filter(user=user).update(verified=False)
        elif denial == "inactive":
            type(user).objects.filter(id=user.id).update(is_active=False)
        elif denial == "membership":
            WorkspaceMembership.objects.filter(
                workspace=assignment.workspace, user=user
            ).update(active=False)
        elif denial == "role":
            WorkspaceMembership.objects.filter(
                workspace=assignment.workspace, user=user
            ).update(role="learner")
        elif denial == "logout":
            Session.objects.filter(session_key=key).delete()
        else:
            assert replacement_session is not None and replacement is not None
            replacement_data = Session.objects.get(
                session_key=replacement_session.session_key
            ).session_data
            Session.objects.filter(session_key=key).update(
                session_data=replacement_data
            )
            WorkspaceMembership.objects.create(
                workspace=assignment.workspace, user=replacement, role="instructor"
            )

    async def check() -> None:
        ws = socket(key)
        assert "text" in await subscribe(ws, assignment, "teaching")
        head = await database_sync_to_async(read_learning_head)(
            key, assignment.id, "teaching"
        )
        await database_sync_to_async(revoke)()
        layer = get_channel_layer()  # type: ignore[no-untyped-call]
        assert layer is not None
        await layer.group_send(
            stream_group(head.access.stream),
            {
                "type": "learning.changed",
                "stream_id": str(stream.id),
                "generation": 1,
            },
        )
        assert (await ws.receive_output(timeout=3))["code"] == 4403
        await disconnect(ws)
        if os.environ.get("CODE_ALONG_TEST_REDIS_URL"):
            await layer.close_pools()

    with override_settings(CHANNEL_LAYERS=layer_settings()):
        asyncio.run(check())

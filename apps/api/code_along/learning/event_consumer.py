"""Private assignment heads, guarded independently of Source project authority."""

import asyncio
import json
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from typing import Any, cast

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from code_along.collaboration.services import AdmissionError, session_user
from code_along.events.services import session_group

from . import event_wire
from .notification_access import authorize_learning_stream, read_learning_head
from .notification_types import (
    MAX_GENERATION,
    Audience,
    LearningAccess,
    LearningDenied,
    LearningHead,
    stream_group,
)

HEARTBEAT_SECONDS = 10
AUTHORITY_SECONDS = 30
AUTHORITY_TIMEOUT = 2


def _principal(session_key: str | None) -> uuid.UUID:
    try:
        return session_user(session_key)[0].id
    except AdmissionError:
        raise LearningDenied() from None


class LearningConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self) -> None:
        self.closed = False
        self.subscribed = False
        self.session_key: str | None = self.scope["session"].session_key
        self.user_id: uuid.UUID | None = None
        self.assignment_id: uuid.UUID | None = None
        self.audience: Audience | None = None
        self.access: LearningAccess | None = None
        self.private_group: str | None = None
        self.audience_group: str | None = None
        self.monitor: asyncio.Task[None] | None = None
        self.deadline = time.monotonic() + AUTHORITY_SECONDS
        try:
            self.user_id = await self.checked(_principal, self.session_key)
            if not self.session_key:
                raise LearningDenied()
            self.private_group = session_group(self.session_key)
            await asyncio.wait_for(
                self.channel_layer.group_add(self.private_group, self.channel_name),
                timeout=AUTHORITY_TIMEOUT,
            )
            await self.accept()  # type: ignore[no-untyped-call]  # Channels boundary.
            self.monitor = asyncio.create_task(self.watch())
        except LearningDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def checked[T](
        self, operation: Callable[..., T], *args: Any, **kwargs: Any
    ) -> T:
        old_deadline = self.deadline
        started = time.monotonic()
        if self.closed or started >= old_deadline:
            raise TimeoutError("authorization_unavailable")
        result = await asyncio.wait_for(
            database_sync_to_async(operation)(*args, **kwargs),
            timeout=AUTHORITY_TIMEOUT,
        )
        # Compare the old authority deadline after awaiting: a late answer, or a
        # concurrent heartbeat, cannot extend the authority that guarded this call.
        if self.closed or time.monotonic() >= old_deadline:
            raise TimeoutError("authorization_unavailable")
        self.deadline = started + AUTHORITY_SECONDS
        return cast(T, result)

    async def head(self) -> LearningHead:
        if self.assignment_id is None or self.audience is None or self.access is None:
            raise LearningDenied()
        result = await self.checked(
            read_learning_head,
            self.session_key,
            self.assignment_id,
            self.audience,
            expected_user_id=self.user_id,
        )
        if result.access != self.access:
            raise LearningDenied()
        if (
            type(result.generation) is not int
            or not 0 <= result.generation <= MAX_GENERATION
        ):
            raise ValueError("invalid_head")
        return result

    async def receive(
        self,
        text_data: str | None = None,
        bytes_data: bytes | None = None,
        **kwargs: Any,
    ) -> None:
        if self.closed:
            return
        try:
            if self.subscribed or text_data is None or bytes_data is not None:
                raise ValueError("invalid_message")
            assignment_id, audience, after = event_wire.subscribe(text_data)
        except (ValueError, UnicodeError, RecursionError):
            await self.finish(4400, "invalid_message")
            return
        try:
            access = await self.checked(
                authorize_learning_stream,
                self.session_key,
                assignment_id,
                audience,
                expected_user_id=self.user_id,
            )
            if (
                access.user_id != self.user_id
                or access.stream.assignment_id != assignment_id
            ):
                raise LearningDenied()
            if (
                audience == "teaching" and access.stream.audience_user_id is not None
            ) or (
                audience == "participant"
                and access.stream.audience_user_id != self.user_id
            ):
                raise LearningDenied()
            self.assignment_id, self.audience, self.access = (
                assignment_id,
                audience,
                access,
            )
            self.audience_group = stream_group(access.stream)
            # Join before the fresh authorized head. Queued markers cannot create
            # a gap between the HTTP head and broker subscription.
            await asyncio.wait_for(
                self.channel_layer.group_add(self.audience_group, self.channel_name),
                timeout=AUTHORITY_TIMEOUT,
            )
            head = await self.head()
            self.subscribed = True
            await self.frame(
                event_wire.frame(
                    assignment_id,
                    audience,
                    "subscribed",
                    head.generation,
                    refresh_required=after != head.generation,
                )
            )
        except LearningDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def frame(self, value: dict[str, Any]) -> None:
        if self.closed:
            return
        if time.monotonic() >= self.deadline:
            raise TimeoutError("authorization_unavailable")
        text = json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        if len(text.encode("utf-8")) > event_wire.MAX_FRAME_BYTES:
            raise ValueError("invalid_frame")
        await self.send(text_data=text)  # type: ignore[no-untyped-call]

    async def learning_changed(self, event: dict[str, Any]) -> None:
        if self.closed or not self.subscribed:
            return
        try:
            head = await self.head()
            if (
                set(event) != {"type", "stream_id", "generation"}
                or event["type"] != "learning.changed"
                or event_wire.uuid_value(event["stream_id"]) != head.access.stream.id
                or type(event["generation"]) is not int
                or not 0 < event["generation"] <= head.generation
            ):
                raise ValueError("invalid_marker")
            assert self.assignment_id is not None and self.audience is not None
            await self.frame(
                event_wire.frame(
                    self.assignment_id,
                    self.audience,
                    "learning.changed",
                    event["generation"],
                )
            )
        except LearningDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def access_invalidated(self, event: dict[str, Any]) -> None:
        await self.finish(4403, "unauthorized")

    async def watch(self) -> None:
        try:
            while not self.closed:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                if not self.subscribed:
                    await self.finish(4400, "invalid_message")
                    return
                head = await self.head()
                assert self.assignment_id is not None and self.audience is not None
                await self.frame(
                    event_wire.frame(
                        self.assignment_id, self.audience, "head", head.generation
                    )
                )
        except asyncio.CancelledError:
            raise
        except LearningDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def finish(self, code: int, reason: str) -> None:
        if not self.closed:
            self.closed = True
            await self.close(code=code, reason=reason)  # type: ignore[no-untyped-call]

    async def disconnect(self, code: int) -> None:
        self.closed = True
        if self.monitor is not None:
            self.monitor.cancel()
            with suppress(asyncio.CancelledError):
                await self.monitor
        for group in (self.private_group, self.audience_group):
            if group:
                with suppress(Exception):
                    await asyncio.wait_for(
                        self.channel_layer.group_discard(group, self.channel_name),
                        timeout=AUTHORITY_TIMEOUT,
                    )

import asyncio
import json
import time
import uuid
from contextlib import suppress
from typing import Any

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .authorization import EventDenied, authority, subscription
from .contracts import MAX_COMMAND_BYTES, MAX_FRAME_BYTES, PROTOCOL, VERSION, subscribe
from .services import project_group, session_group

HEARTBEAT_SECONDS = 10


class ProjectEventsConsumer(AsyncJsonWebsocketConsumer):
    """Only notifications flow here; durable mutations remain session/CSRF HTTP."""

    async def connect(self) -> None:
        self.project_id: uuid.UUID | None = None
        self.closed = False
        self.session_key: str | None = self.scope["session"].session_key
        self.deadline = time.monotonic() + 30
        self.monitor: asyncio.Task[None] | None = None
        self.subscribed = False
        self.private_group: str | None = None
        try:
            await self.check_authority()
            if not self.session_key:
                raise EventDenied()
            self.private_group = session_group(self.session_key)
            await asyncio.wait_for(
                self.channel_layer.group_add(self.private_group, self.channel_name),
                timeout=2,
            )
            await self.accept()  # type: ignore[no-untyped-call]  # Channels boundary.
            self.monitor = asyncio.create_task(self.watch())
        except EventDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def check_authority(self) -> Any:
        if self.closed or time.monotonic() >= self.deadline:
            raise TimeoutError("authorization_unavailable")
        started = time.monotonic()
        result = await asyncio.wait_for(
            database_sync_to_async(authority)(self.session_key, self.project_id),
            timeout=2,
        )
        if self.closed or time.monotonic() >= self.deadline:
            raise TimeoutError("authorization_unavailable")
        self.deadline = started + 30
        return result

    async def finish(self, code: int, reason: str) -> None:
        self.closed = True
        await self.close(code=code, reason=reason)  # type: ignore[no-untyped-call]

    async def receive(
        self,
        text_data: str | None = None,
        bytes_data: bytes | None = None,
        **kwargs: Any,
    ) -> None:
        try:
            if (
                self.subscribed
                or text_data is None
                or bytes_data is not None
                or len(text_data.encode("utf-8", errors="strict")) > MAX_COMMAND_BYTES
            ):
                raise ValueError("invalid_message")
            project_id, after = subscribe(json.loads(text_data))
            await self.check_authority()
            await asyncio.wait_for(
                database_sync_to_async(authority)(self.session_key, project_id),
                timeout=2,
            )
            self.project_id = project_id
            self.subscribed = True
            # Group first, then read the authoritative head/replay. Consumer handlers are sequential.
            await asyncio.wait_for(
                self.channel_layer.group_add(
                    project_group(project_id), self.channel_name
                ),
                timeout=2,
            )
            page = await asyncio.wait_for(
                database_sync_to_async(subscription)(
                    self.session_key, project_id, after
                ),
                timeout=2,
            )
            await self.frame(
                {
                    "protocol": PROTOCOL,
                    "version": VERSION,
                    "type": "subscribed",
                    "project_id": str(project_id),
                    "head_sequence": page["head_sequence"],
                    "refresh_required": page["refresh_required"],
                    "events": page["items"],
                }
            )
        except (ValueError, UnicodeError):
            await self.finish(4400, "invalid_message")
        except EventDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def frame(self, value: dict[str, Any]) -> None:
        if self.closed:
            return
        if time.monotonic() >= self.deadline:
            raise TimeoutError("authorization_unavailable")
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_FRAME_BYTES:
            await self.finish(4400, "invalid_message")
            return
        await self.send(text_data=text)  # type: ignore[no-untyped-call]

    async def project_event(self, event: dict[str, Any]) -> None:
        if not self.subscribed or self.closed:
            return
        try:
            await (
                self.check_authority()
            )  # Includes actual session/hash and current ordinary grants.
            value = event["event"]
            if not isinstance(value, dict) or value.get("project_id") != str(
                self.project_id
            ):
                raise ValueError("invalid_event")
            await self.frame(value)
        except EventDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def access_invalidated(self, event: dict[str, Any]) -> None:
        await self.finish(4403, "unauthorized")

    async def watch(self) -> None:
        try:
            while not self.closed:
                await asyncio.sleep(HEARTBEAT_SECONDS)
                project = await self.check_authority()
                if project is not None:
                    await self.frame(
                        {
                            "protocol": PROTOCOL,
                            "version": VERSION,
                            "type": "head",
                            "project_id": str(project.id),
                            "head_sequence": str(project.event_sequence),
                        }
                    )
                elif not self.subscribed:
                    await self.finish(4400, "invalid_message")
        except asyncio.CancelledError:
            raise
        except EventDenied:
            await self.finish(4403, "unauthorized")
        except Exception:
            await self.finish(4401, "authorization_unavailable")

    async def disconnect(self, code: int) -> None:
        self.closed = True
        if self.monitor is not None:
            self.monitor.cancel()
            with suppress(asyncio.CancelledError):
                await self.monitor
        groups = [
            self.private_group,
            project_group(self.project_id) if self.project_id else None,
        ]
        for group in groups:
            if group:
                with suppress(Exception):
                    await asyncio.wait_for(
                        self.channel_layer.group_discard(group, self.channel_name),
                        timeout=2,
                    )

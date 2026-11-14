import asyncio
import json
import uuid
from contextlib import nullcontext
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import pytest
from asgiref.testing import ApplicationCommunicator
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from config.asgi import application
from django.conf import settings
from django.contrib.sessions.models import Session
from django.db import IntegrityError, transaction
from django.test import Client, override_settings

from code_along.collaboration.services import revoke_leases
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.events import contracts, services
from code_along.events.models import InvalidationDelivery, OutboxEvent
from code_along.projects import services as projects
from code_along.projects.models import Project
from code_along.workspaces import services as workspaces
from code_along.workspaces.tests.test_workspaces import person, signed_in


def fixture_project() -> tuple[Project, Client]:
    ensure_runtime_catalog()
    owner = person("events-owner")
    workspace = workspaces.create_workspace(owner, "Events group")
    project = projects.create_project(owner, workspace.id, "Events project")
    return project, signed_in(owner)


@pytest.mark.parametrize("value", [0, True, "00", "01", "-1", "1.0", "١", str(2**63)])
def test_sequence_rejects_noncanonical_or_unsafe_values(value: Any) -> None:
    with pytest.raises(ValueError):
        contracts.sequence(value)


def test_protocol_requires_exact_command_and_preserves_safe_decimal_and_utc() -> None:
    project = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    command = {
        "protocol": contracts.PROTOCOL,
        "version": 1,
        "type": "subscribe",
        "project_id": str(project),
        "after_sequence": str(2**63 - 1),
    }
    assert contracts.subscribe(command) == (project, 2**63 - 1)
    for bad in (
        {**command, "token": "forbidden"},
        {**command, "version": True},
        {**command, "project_id": str(project).upper()},
    ):
        with pytest.raises(ValueError):
            contracts.subscribe(bad)
    assert contracts.utc(datetime(2026, 1, 1, tzinfo=UTC)) == "2026-01-01T00:00:00Z"
    with pytest.raises(ValueError):
        contracts.utc(datetime(2026, 1, 1))


@pytest.mark.postgres
@pytest.mark.django_db
class TestDurableEvents:
    def test_metadata_events_commit_atomically_and_replay_never_skips_a_limited_page(
        self,
    ) -> None:
        project, client = fixture_project()
        assert project.event_sequence == 1
        with pytest.raises(RuntimeError), transaction.atomic():
            projects.add_file(project.owner, project.id, 1, "rolled_back.py")
            raise RuntimeError("rollback")
        project.refresh_from_db()
        assert project.event_sequence == 1 and OutboxEvent.objects.count() == 1
        projects.add_file(project.owner, project.id, 1, "kept.py")
        projects.update_project(project.owner, project.id, 2, name="Changed")
        page = client.get(
            f"/api/v1/projects/{project.id}/events/?after=0&limit=1"
        ).json()
        assert page["head_sequence"] == "3" and page["next_after"] == "1"
        assert not page["refresh_required"] and len(page["items"]) == 1
        next_page = client.get(f"/api/v1/projects/{project.id}/events/?after=1").json()
        assert [event["sequence"] for event in next_page["items"]] == ["2", "3"]
        assert next_page["next_after"] == "3"
        assert all(
            event["event_type"] == "project.changed" for event in next_page["items"]
        )
        assert all(
            set(event["data"]) == {"metadata_version"} for event in page["items"]
        )

    def test_replay_detects_pruned_missing_future_and_overflow_without_false_refresh_at_zero(
        self,
    ) -> None:
        project, _ = fixture_project()
        assert not services.replay(project, 0, limit=10)["refresh_required"]
        projects.add_file(project.owner, project.id, 1, "second.py")
        project.refresh_from_db()
        assert services.replay(project, 0, limit=1, complete=True)["refresh_required"]
        OutboxEvent.objects.filter(project=project, sequence=1).delete()
        for after in (0, 3, None):
            page = services.replay(project, after, limit=10)
            assert page == {
                "items": [],
                "head_sequence": "2",
                "next_after": "2",
                "refresh_required": True,
            }
        assert not services.replay(project, 1, limit=10)["refresh_required"]

    def test_private_logout_delivery_survives_session_delete_and_is_never_public(
        self,
    ) -> None:
        project, client = fixture_project()
        key = client.session.session_key
        assert key
        before = project.event_sequence
        revoke_leases(
            session_key=key
        )  # Also invalidates events-only sockets with no Yjs lease.
        Session.objects.filter(session_key=key).delete()
        delivery = InvalidationDelivery.objects.get()
        assert (
            delivery.lease_ids == []
            and delivery.session_group == services.session_group(key)
        )
        project.refresh_from_db()
        assert project.event_sequence == before
        assert "session" not in json.dumps(
            services.public_event(OutboxEvent.objects.get())
        )

    def test_private_rows_have_database_payload_bounds(self) -> None:
        invalid: tuple[dict[str, Any], ...] = (
            {"lease_ids": []},
            {"lease_ids": [str(uuid.uuid4())] * 129},
            {"lease_ids": [], "session_group": "session.raw-cookie"},
        )
        for values in invalid:
            with pytest.raises(IntegrityError), transaction.atomic():
                InvalidationDelivery.objects.create(**values)

    def test_workspace_and_project_access_changes_emit_only_current_version_projections(
        self,
    ) -> None:
        project, client = fixture_project()
        workspaces.update_workspace(
            project.owner, project.workspace_id, name="Renamed group"
        )
        project.refresh_from_db()
        event = OutboxEvent.objects.filter(project=project).latest("sequence")
        assert services.public_event(event)["data"] == {
            "project_acl_version": "1",
            "workspace_acl_version": "2",
        }
        response = client.get(f"/api/v1/projects/{project.id}/events/?after=00")
        assert response.status_code == 400


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
@override_settings(
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
)
def test_authenticated_socket_replay_head_and_private_revocation() -> None:
    project, client = fixture_project()
    key = client.session.session_key
    assert key

    async def check() -> None:
        socket = ApplicationCommunicator(
            application,
            {
                "type": "websocket",
                "path": "/events",
                "query_string": b"",
                "headers": [
                    (b"origin", b"https://testserver"),
                    (b"cookie", f"{settings.SESSION_COOKIE_NAME}={key}".encode()),
                ],
            },
        )
        await socket.send_input({"type": "websocket.connect"})
        assert (await socket.receive_output(timeout=3))["type"] == "websocket.accept"
        command = {
            "protocol": contracts.PROTOCOL,
            "version": 1,
            "type": "subscribe",
            "project_id": str(project.id),
            "after_sequence": "0",
        }
        await socket.send_input(
            {"type": "websocket.receive", "text": json.dumps(command)}
        )
        frame = json.loads((await socket.receive_output(timeout=3))["text"])
        assert frame["type"] == "subscribed" and frame["head_sequence"] == "1"
        assert frame["events"][0]["sequence"] == "1" and not frame["refresh_required"]

        # The final dropped publication has no later event to expose its gap; the head repairs it.
        def missed() -> None:
            projects.update_project(
                project.owner, project.id, 1, name="Missed notification"
            )

        await database_sync_to_async(missed)()
        heartbeat = json.loads((await socket.receive_output(timeout=3))["text"])
        assert heartbeat["type"] == "head" and heartbeat["head_sequence"] == "2"
        layer = get_channel_layer()  # type: ignore[no-untyped-call]  # Channels boundary.
        assert layer is not None
        await layer.group_send(
            services.session_group(key), {"type": "access.invalidated"}
        )
        assert await socket.receive_output(timeout=3) == {
            "type": "websocket.close",
            "code": 4403,
            "reason": "unauthorized",
        }
        await socket.send_input({"type": "websocket.disconnect", "code": 1000})
        await socket.wait(timeout=3)

    with patch("code_along.events.consumer.HEARTBEAT_SECONDS", 0.05):
        asyncio.run(check())


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
@override_settings(
    CHANNEL_LAYERS={"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
)
@pytest.mark.parametrize("denial", ["role", "password", "unavailable", "malformed"])
def test_socket_rechecks_authority_before_forwarding_and_rejects_invalid_commands(
    denial: str,
) -> None:
    project, client = fixture_project()
    key = client.session.session_key

    async def check() -> None:
        socket = ApplicationCommunicator(
            application,
            {
                "type": "websocket",
                "path": "/events",
                "query_string": b"",
                "headers": [
                    (b"origin", b"https://testserver"),
                    (b"cookie", f"{settings.SESSION_COOKIE_NAME}={key}".encode()),
                ],
            },
        )
        await socket.send_input({"type": "websocket.connect"})
        assert (await socket.receive_output(timeout=3))["type"] == "websocket.accept"
        command = {
            "protocol": contracts.PROTOCOL,
            "version": 1,
            "type": "subscribe",
            "project_id": str(project.id),
            "after_sequence": None,
        }
        if denial == "malformed":
            command["extra"] = "no"
        await socket.send_input(
            {"type": "websocket.receive", "text": json.dumps(command)}
        )
        first = await socket.receive_output(timeout=3)
        if denial == "malformed":
            assert first["code"] == 4400
        else:
            assert json.loads(first["text"])["type"] == "subscribed"
            if denial == "role":

                def remove() -> None:
                    project.workspace.memberships.update(active=False)

                await database_sync_to_async(remove)()
            elif denial == "password":

                def password() -> None:
                    project.owner.set_password("changed-session-authority-84!")
                    project.owner.save(update_fields=["password"])

                await database_sync_to_async(password)()
            layer = get_channel_layer()  # type: ignore[no-untyped-call]
            assert layer is not None
            with (
                patch(
                    "code_along.events.consumer.authority",
                    side_effect=RuntimeError("offline"),
                )
                if denial == "unavailable"
                else nullcontext()
            ):
                await layer.group_send(
                    services.project_group(project.id),
                    {"type": "project.event", "event": {"project_id": str(project.id)}},
                )
                closed = await socket.receive_output(timeout=3)
            assert closed["type"] == "websocket.close"
            assert closed["code"] == (4401 if denial == "unavailable" else 4403)
        await socket.send_input({"type": "websocket.disconnect", "code": 1000})
        await socket.wait(timeout=3)

    asyncio.run(check())

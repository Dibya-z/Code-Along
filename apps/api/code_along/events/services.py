import hashlib
import json
import uuid
from typing import Any

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F
from rest_framework.exceptions import APIException

from code_along.projects.models import Project

from .contracts import MAX_SEQUENCE, PROTOCOL, VERSION, utc, uuid_value
from .models import InvalidationDelivery, OutboxEvent


class EventLimit(APIException):
    status_code = 429
    default_detail = "This project's event sequence limit was reached."


def project_group(project_id: uuid.UUID) -> str:
    return "project." + project_id.hex


def session_group(session_key: str) -> str:
    return "session." + hashlib.sha256(session_key.encode("ascii")).hexdigest()


def _wake() -> None:
    if settings.CELERY_BROKER_URL is None:
        return
    try:
        from .tasks import wake_dispatcher

        wake_dispatcher()
    except Exception:
        pass  # A broker/import failure cannot undo durable rows or expose connection details.


def validate_payload(event_type: str, payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ValueError("invalid_event")
    if event_type == "project.changed":
        if (
            set(payload) != {"metadata_version"}
            or type(payload["metadata_version"]) is not int
            or not 1 <= payload["metadata_version"] <= 9007199254740991
        ):
            raise ValueError("invalid_event")
    elif event_type == "project.access.changed":
        if set(payload) != {"project_acl_version", "workspace_acl_version"}:
            raise ValueError("invalid_event")
        for value in payload.values():
            if (
                not isinstance(value, str)
                or not value.isascii()
                or not value.isdecimal()
                or str(int(value)) != value
                or not 1 <= int(value) <= MAX_SEQUENCE
            ):
                raise ValueError("invalid_event")
    elif event_type in {"revision.created", "chat.message.created"}:
        key = "revision_id" if event_type == "revision.created" else "message_id"
        if set(payload) != {key}:
            raise ValueError("invalid_event")
        uuid_value(payload[key])
    else:
        raise ValueError("invalid_event")


def emit_project_event(
    project: Project, event_type: str, payload: dict[str, Any]
) -> OutboxEvent:
    """Caller holds workspace -> project locks; event/head commit with its mutation."""
    if not connection.in_atomic_block:
        raise RuntimeError("event_transaction_required")
    validate_payload(event_type, payload)
    updated = Project.objects.filter(
        id=project.id, event_sequence__lt=MAX_SEQUENCE
    ).update(event_sequence=F("event_sequence") + 1)
    if not updated:
        raise EventLimit()
    project.refresh_from_db(fields=["event_sequence"])
    event = OutboxEvent.objects.create(
        project=project,
        sequence=project.event_sequence,
        event_type=event_type,
        payload=json.loads(json.dumps(payload)),
    )
    transaction.on_commit(_wake)
    return event


def project_changed(project: Project) -> OutboxEvent:
    return emit_project_event(
        project, "project.changed", {"metadata_version": project.metadata_version}
    )


def project_access_changed(project: Project) -> OutboxEvent:
    return emit_project_event(
        project,
        "project.access.changed",
        {
            "project_acl_version": str(project.acl_version),
            "workspace_acl_version": str(project.workspace.acl_version),
        },
    )


def workspace_access_changed(workspace_id: uuid.UUID) -> None:
    # Workspace callers already own the first lock; always acquire project rows in stable order.
    for project in (
        Project.objects.filter(workspace_id=workspace_id)
        .select_related("workspace")
        .select_for_update(of=("self",))
        .order_by("id")
    ):
        project_access_changed(project)


def enqueue_invalidation(lease_ids: list[str], session_key: str | None = None) -> None:
    if not connection.in_atomic_block:
        raise RuntimeError("invalidation_transaction_required")
    if any(not isinstance(value, str) for value in lease_ids):
        raise ValueError("invalid_invalidation")
    for value in lease_ids:
        uuid_value(value)
    group = session_group(session_key) if session_key else None
    for start in range(0, max(1 if group else 0, len(lease_ids)), 128):
        InvalidationDelivery.objects.create(
            lease_ids=lease_ids[start : start + 128], session_group=group
        )
    if lease_ids or group:
        transaction.on_commit(_wake)


def public_event(event: OutboxEvent) -> dict[str, Any]:
    validate_payload(event.event_type, event.payload)
    data = dict(event.payload)
    if event.event_type == "chat.message.created":
        from code_along.chat.models import ChatMessage
        from code_along.chat.services import message_data

        message = ChatMessage.objects.get(
            id=data["message_id"], project_id=event.project_id, sequence=event.sequence
        )
        data = {"message": message_data(message)}
    return {
        "protocol": PROTOCOL,
        "version": VERSION,
        "type": "event",
        "id": str(event.id),
        "project_id": str(event.project_id),
        "sequence": str(event.sequence),
        "event_type": event.event_type,
        "occurred_at": utc(event.occurred_at),
        "data": data,
    }


def replay(
    project: Project, after: int | None, *, limit: int, complete: bool = False
) -> dict[str, Any]:
    head = project.event_sequence
    empty = {
        "items": [],
        "head_sequence": str(head),
        "next_after": str(head),
        "refresh_required": True,
    }
    if after is None or after > head:
        return empty
    selected = list(
        OutboxEvent.objects.filter(
            project=project, sequence__gt=after, sequence__lte=head
        ).order_by("sequence")[: limit + 1]
    )
    expected = after + 1
    for row in selected:
        if row.sequence != expected:
            return empty
        expected += 1
    if (complete and len(selected) > limit) or (
        len(selected) <= limit and expected - 1 < head
    ):
        return empty
    chosen = selected[:limit]
    return {
        "items": [public_event(row) for row in chosen],
        "head_sequence": str(head),
        "next_after": str(chosen[-1].sequence if chosen else after),
        "refresh_required": False,
    }

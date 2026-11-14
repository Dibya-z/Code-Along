import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from rest_framework.exceptions import APIException, ValidationError

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.events.contracts import utc
from code_along.events.services import emit_project_event
from code_along.projects.policies import project_role, visible_projects
from code_along.projects.revision_services import current_actor
from code_along.projects.services import lock_project, require_editable

from .models import ChatMessage

MAX_MESSAGES = 10000
MAX_CHAT_BYTES = 32 * 1024 * 1024
BLANK_CODEPOINTS = frozenset(
    "\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f\u0020"
    "\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


class ChatConflict(APIException):
    status_code = 409
    default_detail = "This message identity was already used for different content."


class ChatLimit(APIException):
    status_code = 429
    default_detail = "This project's chat storage limit was reached."


def body_bytes(body: str) -> int:
    try:
        raw = body.encode("utf-8", errors="strict")
    except UnicodeError:
        raise ValidationError({"body": "Use valid UTF-8 chat text."}) from None
    if (
        all(character in BLANK_CODEPOINTS for character in body)
        or b"\0" in raw
        or len(raw) > 4096
    ):
        raise ValidationError(
            {"body": "Use nonblank text of at most 4096 UTF-8 bytes without NUL."}
        )
    return len(raw)


def message_data(message: ChatMessage) -> dict[str, Any]:
    return {
        "id": str(message.id),
        "project_id": str(message.project_id),
        "client_message_id": str(message.client_message_id),
        "sequence": str(message.sequence),
        "author": {
            "id": str(message.author_id),
            "display_name": message.author_display_name,
        },
        "body": None if message.deleted_at else message.body,
        "created_at": utc(message.created_at),
        "deleted": message.deleted_at is not None,
    }


@transaction.atomic
def send_message(
    user: User,
    session_key: str | None,
    project_id: uuid.UUID,
    *,
    client_message_id: uuid.UUID,
    body: str,
) -> tuple[ChatMessage, bool]:
    length = body_bytes(body)
    project = lock_project(project_id)
    current = current_actor(user, session_key)
    project_role(project, current, write=True)
    require_editable(project)
    previous = ChatMessage.objects.filter(
        author=current, client_message_id=client_message_id
    ).first()
    if previous is not None:
        if previous.project_id != project.id or previous.body != body:
            raise ChatConflict()
        return previous, False
    used = project.chat_messages.aggregate(total=Sum("body_bytes"))["total"] or 0
    if project.chat_messages.count() >= MAX_MESSAGES or used + length > MAX_CHAT_BYTES:
        raise ChatLimit()
    message_id = uuid.uuid4()
    try:
        with transaction.atomic():
            event = emit_project_event(
                project, "chat.message.created", {"message_id": str(message_id)}
            )
            message = ChatMessage.objects.create(
                id=message_id,
                project=project,
                author=current,
                author_display_name=public_display_name(current.display_name),
                client_message_id=client_message_id,
                sequence=event.sequence,
                body=body,
                body_bytes=length,
            )
    except IntegrityError:
        raise ChatConflict() from None
    return message, True


def history(
    user: User,
    project_id: uuid.UUID,
    *,
    after: int | None,
    before: int | None,
    limit: int,
) -> dict[str, Any]:
    project = get_object_or_404(visible_projects(user), id=project_id)
    project_role(project, user)
    if after is not None and after > project.event_sequence:
        raise ValidationError(
            {"after": "Refresh the project before using this chat cursor."}
        )
    query = ChatMessage.objects.filter(
        project=project, sequence__lte=project.event_sequence
    )
    if after is not None:
        selected = list(
            query.filter(sequence__gt=after).order_by("sequence")[: limit + 1]
        )
        has_more = len(selected) > limit
        items = selected[:limit]
        next_after = items[-1].sequence if items else after
    else:
        selected = list(
            (
                query.filter(sequence__lt=before) if before is not None else query
            ).order_by("-sequence")[: limit + 1]
        )
        has_more = len(selected) > limit
        items = list(reversed(selected[:limit]))
        next_after = items[-1].sequence if items else 0
    next_before = (
        items[0].sequence
        if items and query.filter(sequence__lt=items[0].sequence).exists()
        else None
    )
    return {
        "items": [message_data(message) for message in items],
        "next_after": str(next_after),
        "next_before": str(next_before) if next_before is not None else None,
        "has_more": has_more,
        "head_sequence": str(project.event_sequence),
    }

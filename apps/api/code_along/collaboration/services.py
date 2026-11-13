"""Django owns live authority; ticket IDs and Yjs counters grant no access."""

import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any, Literal
from urllib.error import URLError
from urllib.request import Request, urlopen

from allauth.account.models import EmailAddress
from django.conf import settings
from django.contrib.auth import get_user
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone
from rest_framework.exceptions import APIException

from code_along.accounts.models import User
from code_along.projects.models import CollaborationDocument, Project
from code_along.projects.policies import project_role
from code_along.projects.services import lock_project, require_editable

from .models import CollaborationLease, CollaborationTicket
from .profiles import public_display_name

TTL = timedelta(seconds=30)
MAX_SESSION_ADMISSIONS = 128
COLORS = (
    "#2563eb",
    "#7c3aed",
    "#db2777",
    "#dc2626",
    "#ea580c",
    "#059669",
    "#0891b2",
    "#4f46e5",
)
ErrorCode = Literal[
    "unauthorized",
    "generation_mismatch",
    "lease_expired",
    "resource_limit",
    "unavailable",
]


class AdmissionError(Exception):
    def __init__(self, code: ErrorCode) -> None:
        self.code = code
        super().__init__(code)

    @property
    def status(self) -> int:
        return {
            "unauthorized": 403,
            "generation_mismatch": 409,
            "lease_expired": 403,
            "resource_limit": 429,
            "unavailable": 503,
        }[self.code]


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def session_user(session_key: str | None) -> tuple[User, Session]:
    if not session_key:
        raise AdmissionError("unauthorized")
    session = Session.objects.filter(
        session_key=session_key, expire_date__gt=timezone.now()
    ).first()
    if session is None:
        raise AdmissionError("unauthorized")
    request = HttpRequest()
    request.session = SessionStore(session_key=session_key)
    user = get_user(
        request
    )  # Framework backend + password/session auth-hash validation.
    if (
        not isinstance(user, User)
        or not user.is_active
        or request.session.session_key != session_key
        or not EmailAddress.objects.filter(
            user=user, email=user.email, verified=True, primary=True
        ).exists()
    ):
        raise AdmissionError("unauthorized")
    return user, session


def admitted_document(
    project: Project, user: User, document_id: uuid.UUID, generation: int, scope: str
) -> CollaborationDocument:
    try:
        project_role(project, user, write=scope == "write")
        if scope == "write":
            require_editable(project)
    except APIException:
        raise AdmissionError("unauthorized") from None
    document = (
        CollaborationDocument.objects.select_related("file")
        .filter(id=document_id, project=project, file__deleted_at__isnull=True)
        .first()
    )
    if (
        document is None
        or document.generation != generation
        or document.file is None
        or document.file.project_id != project.id
        or document.file.generation != generation
        or document.kind != "text"
        or document.schema_version != 1
    ):
        raise AdmissionError("generation_mismatch")
    return document


def checked_project(project_id: uuid.UUID) -> Project:
    try:
        return lock_project(project_id)
    except APIException:
        raise AdmissionError("unauthorized") from None


@transaction.atomic
def issue_ticket(
    user: User,
    session_key: str | None,
    origin: str,
    project_id: uuid.UUID,
    document_id: uuid.UUID,
    *,
    generation: int,
    scope: str,
    client_session_id: uuid.UUID,
    awareness_client_id: int,
) -> dict[str, Any]:
    if origin != settings.PUBLIC_APP_ORIGIN or not settings.COLLABORATION_SECRET:
        raise AdmissionError("unauthorized")
    project = checked_project(project_id)
    actual_user, session = session_user(session_key)
    if actual_user.id != user.id:
        raise AdmissionError("unauthorized")
    document = admitted_document(project, user, document_id, generation, scope)
    now = timezone.now()
    if (
        CollaborationTicket.objects.filter(
            session=session, expires_at__gt=now, consumed_at__isnull=True
        ).count()
        >= MAX_SESSION_ADMISSIONS
    ):
        raise AdmissionError("resource_limit")
    token = secrets.token_urlsafe(32)
    ticket = CollaborationTicket.objects.create(
        token_digest=digest(token),
        user=user,
        session=session,
        project=project,
        document=document,
        generation=generation,
        scope=scope,
        client_session_id=client_session_id,
        awareness_client_id=awareness_client_id,
        origin=origin,
        expires_at=min(now + TTL, session.expire_date),
    )
    return {
        "ticket": token,
        "expires_at": ticket.expires_at,
        "document_name": f"{document.id}:{generation}",
    }


def grant(
    lease: CollaborationLease,
    token: str,
    project: Project,
    user: User,
    document: CollaborationDocument,
    started: datetime,
) -> dict[str, Any]:
    file = document.file
    assert file is not None
    return {
        "version": 1,
        "lease_id": str(lease.id),
        "lease_token": token,
        "ttl_ms": min(
            30000, max(1, int((lease.expires_at - started).total_seconds() * 1000))
        ),
        "scope": lease.scope,
        "client_session_id": str(lease.client_session_id),
        "awareness_client_id": lease.awareness_client_id,
        "workspace_id": str(project.workspace_id),
        "project_id": str(project.id),
        "workspace_acl_version": str(project.workspace.acl_version),
        "project_acl_version": str(project.acl_version),
        "user": {
            "id": str(user.id),
            "display_name": public_display_name(user.display_name),
            "color": COLORS[user.id.int % len(COLORS)],
        },
        "document": {
            "id": str(document.id),
            "file_id": str(file.id),
            "generation": document.generation,
            "schema_version": document.schema_version,
            "initial_source": file.initial_source,
            "initial_sha256": file.initial_sha256,
        },
    }


@transaction.atomic
def consume_ticket(
    session_key: str | None,
    *,
    ticket: str,
    document_name: str,
    connection_id: uuid.UUID,
    transport_id: uuid.UUID,
    origin: str,
) -> dict[str, Any]:
    candidate = CollaborationTicket.objects.filter(token_digest=digest(ticket)).first()
    if candidate is None or origin != settings.PUBLIC_APP_ORIGIN:
        raise AdmissionError("unauthorized")
    project = checked_project(candidate.project_id)
    stored = CollaborationTicket.objects.select_for_update().get(id=candidate.id)
    user, session = session_user(session_key)
    now = timezone.now()
    if (
        stored.consumed_at is not None
        or stored.expires_at <= now
        or stored.session_id != session.session_key
        or stored.user_id != user.id
        or stored.origin != origin
        or document_name != f"{stored.document_id}:{stored.generation}"
    ):
        raise AdmissionError("unauthorized")
    document = admitted_document(
        project, user, stored.document_id, stored.generation, stored.scope
    )
    if (
        CollaborationLease.objects.filter(
            session=session, expires_at__gt=now, revoked_at__isnull=True
        ).count()
        >= MAX_SESSION_ADMISSIONS
        or CollaborationLease.objects.filter(connection_id=connection_id).exists()
    ):
        raise AdmissionError("resource_limit")
    token = secrets.token_urlsafe(32)
    lease = CollaborationLease.objects.create(
        token_digest=digest(token),
        ticket=stored,
        user=user,
        session=session,
        project=project,
        document=document,
        generation=stored.generation,
        scope=stored.scope,
        connection_id=connection_id,
        transport_id=transport_id,
        client_session_id=stored.client_session_id,
        awareness_client_id=stored.awareness_client_id,
        origin=origin,
        workspace_acl_version=project.workspace.acl_version,
        project_acl_version=project.acl_version,
        renewed_at=now,
        expires_at=min(now + TTL, session.expire_date),
    )
    stored.consumed_at = now
    stored.consumed_connection_id = connection_id
    stored.save(update_fields=["consumed_at", "consumed_connection_id"])
    return grant(lease, token, project, user, document, now)


@transaction.atomic
def renew_lease(
    *,
    lease_id: uuid.UUID,
    lease_token: str,
    connection_id: uuid.UUID,
    document_name: str,
) -> dict[str, Any]:
    candidate = CollaborationLease.objects.filter(id=lease_id).first()
    if candidate is None:
        raise AdmissionError("unauthorized")
    project = checked_project(candidate.project_id)
    lease = CollaborationLease.objects.select_for_update().get(id=lease_id)
    now = timezone.now()
    if (
        not secrets.compare_digest(lease.token_digest, digest(lease_token))
        or lease.connection_id != connection_id
        or document_name != f"{lease.document_id}:{lease.generation}"
        or lease.origin != settings.PUBLIC_APP_ORIGIN
        or lease.revoked_at is not None
    ):
        raise AdmissionError("unauthorized")
    if lease.expires_at <= now:
        raise AdmissionError("lease_expired")
    user, session = session_user(lease.session_id)
    if user.id != lease.user_id:
        raise AdmissionError("unauthorized")
    document = admitted_document(
        project, user, lease.document_id, lease.generation, lease.scope
    )
    lease.workspace_acl_version = project.workspace.acl_version
    lease.project_acl_version = project.acl_version
    lease.renewed_at = now
    lease.expires_at = min(now + TTL, session.expire_date)
    lease.save(
        update_fields=[
            "workspace_acl_version",
            "project_acl_version",
            "renewed_at",
            "expires_at",
        ]
    )
    return grant(lease, lease_token, project, user, document, now)


def send_invalidation(lease_ids: list[str]) -> None:
    url = settings.COLLABORATION_CONTROL_URL
    secret = settings.COLLABORATION_CONTROL_SECRET
    if not url or not secret:
        return
    for start in range(0, len(lease_ids), 128):
        payload = {
            "version": 1,
            "event_id": str(uuid.uuid4()),
            "lease_ids": lease_ids[start : start + 128],
            "reason": "authorization_changed",
        }
        request = Request(
            f"{url}/internal/v1/invalidations/",
            json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {secret}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=0.25) as response:
                response.read(1)
        except (OSError, URLError, ValueError):
            pass  # Leases still expire fail-closed; outbox retries are a later M3 bundle.


def revoke_leases(
    *,
    project_id: uuid.UUID | None = None,
    workspace_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    session_key: str | None = None,
) -> None:
    if not any((project_id, workspace_id, user_id, document_id, session_key)):
        raise ValueError("An explicit invalidation scope is required.")
    query = CollaborationLease.objects.filter(
        revoked_at__isnull=True, expires_at__gt=timezone.now()
    )
    if project_id is not None:
        query = query.filter(project_id=project_id)
    if workspace_id is not None:
        query = query.filter(project__workspace_id=workspace_id)
    if user_id is not None:
        query = query.filter(user_id=user_id)
    if document_id is not None:
        query = query.filter(document_id=document_id)
    if session_key is not None:
        query = query.filter(session_id=session_key)
    ids = [str(value) for value in query.values_list("id", flat=True)]
    if ids:
        query.update(revoked_at=timezone.now())
        transaction.on_commit(lambda: send_invalidation(ids))

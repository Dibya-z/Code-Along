import uuid
from typing import Any
from unittest.mock import patch

import pytest
from django.db import IntegrityError, transaction
from django.test import Client
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from code_along.chat import services
from code_along.chat.api import ChatMessageOutput
from code_along.chat.models import ChatMessage
from code_along.events.models import OutboxEvent
from code_along.events.services import public_event
from code_along.events.tests.test_events import fixture_project
from code_along.projects import services as projects
from code_along.projects import share_services
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in


@pytest.mark.parametrize(
    "body",
    ["", " \r\n\t", "\ufeff", "\u0085", "\u001c\u001f", "a\0b", "🐍" * 1025, "\ud800"],
)
def test_chat_body_enforces_utf8_bytes_without_normalizing_text(body: str) -> None:
    with pytest.raises(ValidationError):
        services.body_bytes(body)


def test_chat_keeps_exact_whitespace_and_unicode() -> None:
    assert services.body_bytes("\ufeffok\u0085\u001f") == 8
    assert services.body_bytes(' café 🐍\r\n\t"\\ ') == len(
        ' café 🐍\r\n\t"\\ '.encode()
    )


def test_chat_blank_set_matches_frozen_cross_language_contract() -> None:
    codepoints = [
        9,
        10,
        11,
        12,
        13,
        28,
        29,
        30,
        31,
        32,
        133,
        160,
        5760,
        8192,
        8193,
        8194,
        8195,
        8196,
        8197,
        8198,
        8199,
        8200,
        8201,
        8202,
        8232,
        8233,
        8239,
        8287,
        12288,
        65279,
    ]
    assert sorted(map(ord, services.BLANK_CODEPOINTS)) == codepoints
    with pytest.raises(ValidationError):
        services.body_bytes("".join(map(chr, codepoints)))


@pytest.mark.postgres
@pytest.mark.django_db
class TestPersistedChat:
    def post(
        self,
        client: Client,
        project: Any,
        body: str = "Hello 🐍\r\n",
        nonce: uuid.UUID | None = None,
    ) -> Any:
        return client.post(
            f"/api/v1/projects/{project.id}/chat/messages/",
            {"client_message_id": str(nonce or uuid.uuid4()), "body": body},
            content_type="application/json",
            secure=True,
        )

    def test_message_and_outbox_commit_once_and_retry_original_after_current_auth(
        self,
    ) -> None:
        project, client = fixture_project()
        nonce = uuid.uuid4()
        response = self.post(client, project, nonce=nonce)
        assert response.status_code == 201, response.content
        original = response.json()
        assert original["body"] == "Hello 🐍\r\n" and original["sequence"] == "2"
        serializer = ChatMessageOutput(data=original)
        assert serializer.is_valid(), serializer.errors
        assert self.post(client, project, nonce=nonce).json() == original
        assert self.post(client, project, nonce=nonce).status_code == 200
        assert self.post(client, project, "different", nonce).status_code == 409
        event = OutboxEvent.objects.get(event_type="chat.message.created")
        assert event.payload == {"message_id": original["id"]}
        assert public_event(event)["data"] == {"message": original}
        assert ChatMessage.objects.count() == 1 and OutboxEvent.objects.count() == 2
        project.owner.set_password("different-authentication-84!")
        project.owner.save(update_fields=["password"])
        assert self.post(client, project, nonce=nonce).status_code == 403

    def test_nonce_is_author_scoped_but_cannot_be_reused_in_another_project(
        self,
    ) -> None:
        project, owner = fixture_project()
        nonce = uuid.uuid4()
        assert self.post(owner, project, nonce=nonce).status_code == 201
        other = projects.create_project(project.owner, project.workspace_id, "Other")
        assert self.post(owner, other, nonce=nonce).status_code == 409
        editor = person("chat-editor")
        WorkspaceMembership.objects.create(
            workspace=project.workspace, user=editor, role="learner"
        )
        projects.set_grant(project.owner, project.id, editor.id, "editor")
        assert self.post(signed_in(editor), project, nonce=nonce).status_code == 201
        assert ChatMessage.objects.filter(client_message_id=nonce).count() == 2

    def test_history_pages_are_exclusive_ascending_and_allow_metadata_sequence_gaps(
        self,
    ) -> None:
        project, client = fixture_project()
        first = self.post(client, project, "one").json()
        projects.add_file(project.owner, project.id, 1, "gap.py")
        second = self.post(client, project, "two").json()
        third = self.post(client, project, "three").json()
        url = f"/api/v1/projects/{project.id}/chat/messages/"
        page = client.get(url + "?limit=2").json()
        assert [item["body"] for item in page["items"]] == ["two", "three"]
        assert page["has_more"] and page["next_before"] == second["sequence"]
        earlier = client.get(url + f"?before={page['next_before']}&limit=2").json()
        assert [item["body"] for item in earlier["items"]] == ["one"]
        assert earlier["next_before"] is None
        after = client.get(url + f"?after={first['sequence']}&limit=1").json()
        assert [item["body"] for item in after["items"]] == ["two"]
        assert after["next_after"] == second["sequence"] and after["has_more"]
        assert page["head_sequence"] == third["sequence"]
        for query in (
            "?after=01",
            "?after=0&before=1",
            "?limit=101",
            "?after=9223372036854775808",
            "?token=forbidden",
        ):
            assert client.get(url + query).status_code == 400

    def test_viewer_reads_editor_posts_archives_block_posts_and_source_capability_grants_no_chat_or_events(
        self,
    ) -> None:
        project, owner = fixture_project()
        assert self.post(owner, project).status_code == 201
        viewer = person("chat-viewer")
        WorkspaceMembership.objects.create(
            workspace=project.workspace, user=viewer, role="learner"
        )
        projects.set_grant(project.owner, project.id, viewer.id, "viewer")
        client = signed_in(viewer)
        url = f"/api/v1/projects/{project.id}/"
        assert client.get(url + "chat/messages/").status_code == 200
        assert self.post(client, project).status_code == 403
        projects.revoke_grant(project.owner, project.id, viewer.id)
        _, token = share_services.create_share(
            project.owner,
            project.id,
            kind="live",
            scope="write",
            revision_id=None,
            recipient_id=None,
            expires_hours=1,
        )
        for endpoint in ("chat/messages/", "events/", "revisions/"):
            assert (
                client.get(url + endpoint, HTTP_X_SHARE_TOKEN=token).status_code == 404
            )
        assert self.post(client, project).status_code == 404
        projects.update_project(project.owner, project.id, 1, archived=True)
        assert owner.get(url + "chat/messages/").status_code == 200
        assert self.post(owner, project).status_code == 400

    def test_outbox_failure_and_quota_leave_no_message_or_sequence_gap_and_tombstone_hydrates_current_state(
        self,
    ) -> None:
        project, client = fixture_project()
        with patch.object(
            OutboxEvent.objects, "create", side_effect=RuntimeError("rollback")
        ):
            with pytest.raises(RuntimeError):
                self.post(client, project)
        project.refresh_from_db()
        assert project.event_sequence == 1 and not ChatMessage.objects.exists()
        with patch.object(services, "MAX_MESSAGES", 0):
            assert self.post(client, project).status_code == 429
        created = self.post(client, project).json()
        ChatMessage.objects.filter(id=created["id"]).update(deleted_at=timezone.now())
        projected = public_event(
            OutboxEvent.objects.get(event_type="chat.message.created")
        )["data"]["message"]
        assert projected["body"] is None and projected["deleted"] is True
        message = ChatMessage.objects.get()
        with pytest.raises(IntegrityError), transaction.atomic():
            ChatMessage.objects.filter(id=message.id).update(body_bytes=1)

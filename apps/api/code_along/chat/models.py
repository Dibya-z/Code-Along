import uuid

from django.conf import settings
from django.db import models


class ChatMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project = models.ForeignKey(
        "projects.Project", on_delete=models.PROTECT, related_name="chat_messages"
    )
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    author_display_name = models.CharField(max_length=80)
    client_message_id = models.UUIDField()
    sequence = models.PositiveBigIntegerField()
    body = models.TextField()
    body_bytes = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["author", "client_message_id"], name="chat_author_nonce"
            ),
            models.UniqueConstraint(
                fields=["project", "sequence"], name="chat_project_sequence"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    sequence__gte=1, body_bytes__gte=1, body_bytes__lte=4096
                ),
                name="chat_message_bounds",
            ),
            models.CheckConstraint(
                condition=~models.Q(body__regex=r"^\s*$"), name="chat_body_nonblank"
            ),
        ]
        indexes = [
            models.Index(fields=["project", "sequence"], name="chat_project_cursor")
        ]

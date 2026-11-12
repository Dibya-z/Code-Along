import uuid

from django.conf import settings
from django.db import models


class Workspace(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_workspaces",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    acl_version = models.PositiveBigIntegerField(default=1)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(name__regex=r"^\s*$"),
                name="workspace_name_nonblank",
            )
        ]
        ordering = ["-created_at", "id"]


class WorkspaceMembership(models.Model):
    class Role(models.TextChoices):
        OWNER = "owner", "Owner"
        INSTRUCTOR = "instructor", "Instructor"
        LEARNER = "learner", "Learner"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace, on_delete=models.PROTECT, related_name="memberships"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="workspace_memberships",
    )
    role = models.CharField(max_length=12, choices=Role.choices)
    active = models.BooleanField(default=True)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace", "user"], name="workspace_member_unique"
            ),
            models.UniqueConstraint(
                fields=["workspace"],
                condition=models.Q(active=True, role="owner"),
                name="workspace_one_active_owner",
            ),
            models.CheckConstraint(
                condition=models.Q(role__in=["owner", "instructor", "learner"]),
                name="workspace_member_valid_role",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "active"], name="workspace_member_user_active")
        ]
        ordering = ["joined_at", "id"]

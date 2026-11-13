"""Explicit public projections for schema generation and response contract tests."""

from rest_framework import serializers

from .api import BodySerializer


class CurrentUserOutput(BodySerializer):
    id = serializers.UUIDField()
    email = serializers.EmailField(max_length=254)
    display_name = serializers.CharField(max_length=80)


class CsrfOutput(BodySerializer):
    csrfToken = serializers.CharField(min_length=64, max_length=64)


class ErrorOutput(BodySerializer):
    detail = serializers.CharField()


class WorkspaceOutput(BodySerializer):
    id = serializers.UUIDField()
    name = serializers.CharField(max_length=100)
    role = serializers.ChoiceField(choices=["owner", "instructor", "learner"])
    archived = serializers.BooleanField()
    acl_version = serializers.RegexField(r"^[1-9][0-9]*$")


class MemberOutput(BodySerializer):
    user_id = serializers.UUIDField()
    display_name = serializers.CharField(max_length=80)
    role = serializers.ChoiceField(choices=["owner", "instructor", "learner"])


class WorkspacePage(BodySerializer):
    items = WorkspaceOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class MemberPage(BodySerializer):
    items = MemberOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class ProjectOutput(BodySerializer):
    id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    owner_id = serializers.UUIDField()
    name = serializers.CharField(max_length=120)
    role = serializers.ChoiceField(choices=["owner", "editor", "viewer"])
    entrypoint_file_id = serializers.UUIDField()
    entrypoint_path = serializers.CharField(max_length=160)
    runtime_profile_id = serializers.UUIDField()
    runtime_id = serializers.CharField(max_length=100)
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    acl_version = serializers.RegexField(r"^[1-9][0-9]*$")
    archived = serializers.BooleanField()
    workspace_archived = serializers.BooleanField()


class ProjectPage(BodySerializer):
    items = ProjectOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class FileMetadata(BodySerializer):
    id = serializers.UUIDField()
    document_id = serializers.UUIDField()
    path = serializers.CharField(max_length=160)
    kind = serializers.ChoiceField(choices=["python"])
    generation = serializers.IntegerField(min_value=1)
    initial_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class FileSource(FileMetadata):
    initial_source = serializers.CharField(allow_blank=True, trim_whitespace=False)


class FilePage(BodySerializer):
    items = FileMetadata(many=True)
    count = serializers.IntegerField(min_value=0, max_value=20)


class GrantOutput(BodySerializer):
    user_id = serializers.UUIDField()
    display_name = serializers.CharField(max_length=80)
    role = serializers.ChoiceField(choices=["editor", "viewer"])


class GrantPage(BodySerializer):
    items = GrantOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class RuntimeOutput(BodySerializer):
    id = serializers.UUIDField()
    runtime_id = serializers.CharField(max_length=100)
    manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class RuntimePage(BodySerializer):
    items = RuntimeOutput(many=True)


class InvitationOutput(BodySerializer):
    id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    project_id = serializers.UUIDField(allow_null=True)
    recipient_email = serializers.EmailField(max_length=254)
    role = serializers.ChoiceField(
        choices=["learner", "instructor", "editor", "viewer"]
    )
    expires_at = serializers.DateTimeField()
    status = serializers.ChoiceField(
        choices=["pending", "accepted", "revoked", "expired"]
    )


class InvitationPage(BodySerializer):
    items = InvitationOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class InvitationCreated(BodySerializer):
    invitation = InvitationOutput()
    invite_url = serializers.URLField()


class InvitationPreview(BodySerializer):
    workspace_name = serializers.CharField(max_length=100)
    project_name = serializers.CharField(max_length=120, allow_null=True)
    role = serializers.ChoiceField(
        choices=["learner", "instructor", "editor", "viewer"]
    )
    accepted = serializers.BooleanField()


class InvitationAccepted(BodySerializer):
    workspace_id = serializers.UUIDField()
    project_id = serializers.UUIDField(allow_null=True)

from typing import Any

from rest_framework import serializers

from code_along.common.api import BodySerializer
from code_along.common.schemas import FileSource


class RevisionAuthor(BodySerializer):
    id = serializers.UUIDField()
    display_name = serializers.CharField(max_length=80)


class RevisionOutput(BodySerializer):
    id = serializers.UUIDField()
    project_id = serializers.UUIDField()
    name = serializers.CharField(max_length=120)
    author = RevisionAuthor()
    created_at = serializers.DateTimeField()
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    provenance = serializers.ChoiceField(choices=["shared_room_capture"])


class RevisionRuntime(BodySerializer):
    runtime_id = serializers.CharField(max_length=100)
    manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    engine = serializers.ChoiceField(choices=["pyodide"])
    engine_version = serializers.CharField()
    python_version = serializers.CharField()


class RevisionHelper(BodySerializer):
    release_id = serializers.ChoiceField(choices=["code-along-python-helpers-v1"])
    source_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class RevisionSource(BodySerializer):
    file_id = serializers.UUIDField()
    document_id = serializers.UUIDField()
    generation = serializers.IntegerField(min_value=1)
    path = serializers.CharField(max_length=160)
    sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")

    def get_fields(self) -> dict[str, Any]:
        # The wire name collides with Field.source, so declare it at the field boundary.
        fields = super().get_fields()
        fields["source"] = serializers.CharField(
            allow_blank=True, trim_whitespace=False
        )
        return fields


class RevisionManifest(BodySerializer):
    protocol = serializers.ChoiceField(choices=["code-along.revision"])
    version = serializers.IntegerField(min_value=1, max_value=1)
    project_id = serializers.UUIDField()
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    entrypoint_file_id = serializers.UUIDField()
    runtime = RevisionRuntime()
    helper_release = RevisionHelper()
    files = RevisionSource(many=True)
    sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class RevisionDetail(RevisionOutput):
    manifest = RevisionManifest()


class RevisionPage(BodySerializer):
    items = RevisionOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class ShareOutput(BodySerializer):
    id = serializers.UUIDField()
    project_id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=["live", "snapshot"])
    scope = serializers.ChoiceField(choices=["read", "write"])
    revision_id = serializers.UUIDField(allow_null=True)
    recipient_id = serializers.UUIDField(allow_null=True)
    created_at = serializers.DateTimeField()
    expires_at = serializers.DateTimeField()
    revoked = serializers.BooleanField()


class ShareCreated(BodySerializer):
    share = ShareOutput()
    share_url = serializers.RegexField(r"^https://[^/?#\s]+/shares#[A-Za-z0-9_-]{43}$")


class SharePage(BodySerializer):
    items = ShareOutput(many=True)
    count = serializers.IntegerField(min_value=0)


class LiveShareAccess(BodySerializer):
    kind = serializers.ChoiceField(choices=["live_share"])
    scope = serializers.ChoiceField(choices=["read", "write"])


class SharedProject(BodySerializer):
    id = serializers.UUIDField()
    name = serializers.CharField(max_length=120)
    entrypoint_file_id = serializers.UUIDField()
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    runtime_id = serializers.CharField(max_length=100)
    archived = serializers.BooleanField()
    workspace_archived = serializers.BooleanField()
    access = LiveShareAccess()


class SharedFiles(BodySerializer):
    items = FileSource(many=True)
    count = serializers.IntegerField(min_value=1, max_value=20)


class LiveShareResolved(BodySerializer):
    kind = serializers.ChoiceField(choices=["live"])
    share_id = serializers.UUIDField()
    expires_at = serializers.DateTimeField()
    scope = serializers.ChoiceField(choices=["read", "write"])
    project = SharedProject()
    files = SharedFiles()


class SnapshotRevision(BodySerializer):
    id = serializers.UUIDField()
    name = serializers.CharField(max_length=120)
    created_at = serializers.DateTimeField()
    manifest = RevisionManifest()


class SnapshotShareResolved(BodySerializer):
    kind = serializers.ChoiceField(choices=["snapshot"])
    share_id = serializers.UUIDField()
    expires_at = serializers.DateTimeField()
    revision = SnapshotRevision()

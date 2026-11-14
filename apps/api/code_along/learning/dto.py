import re
from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ValidationError

from code_along.collaboration.api import StrictIntegerField, StrictUUIDField
from code_along.common.api import BodySerializer, PageSerializer
from code_along.projects.revision_dto import (
    RevisionAuthor,
    RevisionHelper,
    RevisionManifest,
    RevisionRuntime,
)

from . import contracts


class ExactText(serializers.CharField):
    def __init__(
        self,
        *,
        byte_limit: int,
        nonblank: bool = False,
        label_limit: int | None = None,
        **kwargs: Any,
    ) -> None:
        self.byte_limit, self.nonblank, self.label_limit = (
            byte_limit,
            nonblank,
            label_limit,
        )
        super().__init__(trim_whitespace=False, allow_blank=not nonblank, **kwargs)

    def to_internal_value(self, data: Any) -> str:
        value = contracts.text(data, self.byte_limit, nonblank=self.nonblank)
        return contracts.label(value, self.label_limit) if self.label_limit else value


class UTCDateTime(serializers.DateTimeField):
    def to_internal_value(self, value: Any) -> Any:
        if (
            not isinstance(value, str)
            or re.fullmatch(
                r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)",
                value,
            )
            is None
        ):
            raise ValidationError("Use an RFC3339 timestamp with an explicit timezone.")
        return super().to_internal_value(value)


class StrictBoolean(serializers.BooleanField):
    def to_internal_value(self, data: Any) -> bool:
        if type(data) is not bool:
            raise ValidationError("Use a boolean.")
        return data


class AssignmentHint(BodySerializer):
    id = StrictUUIDField()
    title = ExactText(byte_limit=320, nonblank=True, label_limit=80)
    body = ExactText(byte_limit=4096, nonblank=True)


class AssignmentCreate(BodySerializer):
    title = ExactText(byte_limit=480, nonblank=True, label_limit=120)


class AssignmentRevision(BodySerializer):
    expected_revision = StrictIntegerField(min_value=1, max_value=9007199254740991)


class AssignmentArchive(AssignmentRevision):
    archived = StrictBoolean()


class AssignmentPublish(AssignmentRevision):
    client_request_id = StrictUUIDField()


class AssignmentDraftPatch(AssignmentRevision):
    title = ExactText(byte_limit=480, nonblank=True, label_limit=120, required=False)
    instructions = ExactText(byte_limit=32768, required=False)
    hints = AssignmentHint(many=True, required=False)
    public_checks_source = ExactText(
        byte_limit=16384, nonblank=True, allow_null=True, required=False
    )
    starter_revision_id = StrictUUIDField(allow_null=True, required=False)
    submission_mode = serializers.ChoiceField(
        choices=["individual", "team"], required=False
    )
    max_attempts = StrictIntegerField(min_value=1, max_value=100, required=False)
    max_team_size = StrictIntegerField(min_value=1, max_value=6, required=False)
    due_at = UTCDateTime(allow_null=True, required=False)

    def validate_hints(self, value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if (
            len(value) > 8
            or len({hint["id"] for hint in value}) != len(value)
            or sum(len(hint["body"].encode("utf-8")) for hint in value) > 16384
        ):
            raise ValidationError(
                "Use at most eight unique hints with at most 16384 total body bytes."
            )
        return [{**hint, "id": str(hint["id"])} for hint in value]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if set(attrs) == {"expected_revision"}:
            raise ValidationError("Provide at least one draft field.")
        return attrs


class AssignmentListQuery(PageSerializer):
    include_archived = serializers.ChoiceField(
        choices=["true", "false"], default="false"
    )


class AssignmentVersionSummary(BodySerializer):
    id = serializers.UUIDField()
    number = serializers.IntegerField(min_value=1, max_value=50)
    title = serializers.CharField()
    published_at = serializers.DateTimeField()
    content_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    starter_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    submission_mode = serializers.ChoiceField(choices=["individual", "team"])
    due_at = serializers.DateTimeField(allow_null=True)
    max_attempts = serializers.IntegerField(min_value=1, max_value=100)
    max_team_size = serializers.IntegerField(min_value=1, max_value=6)


class AssignmentSummary(BodySerializer):
    id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    title = serializers.CharField()
    archived = serializers.BooleanField()
    published = serializers.BooleanField()
    current_version = AssignmentVersionSummary(allow_null=True)
    can_author = serializers.BooleanField()


class AssignmentPage(BodySerializer):
    items = AssignmentSummary(many=True)
    count = serializers.IntegerField(min_value=0)


class AssignmentVersionPage(BodySerializer):
    items = AssignmentVersionSummary(many=True)
    count = serializers.IntegerField(min_value=0)


class StarterOrigin(BodySerializer):
    kind = serializers.ChoiceField(choices=["owned_project", "published_assignment"])
    assignment_version_id = serializers.UUIDField(required=False)
    number = serializers.IntegerField(min_value=1, required=False)


class AssignmentDraft(BodySerializer):
    assignment_id = serializers.UUIDField()
    revision = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    title = serializers.CharField()
    instructions = serializers.CharField(allow_blank=True, trim_whitespace=False)
    hints = AssignmentHint(many=True)
    public_checks_source = serializers.CharField(allow_null=True, trim_whitespace=False)
    starter_project_id = serializers.UUIDField(allow_null=True)
    starter_revision_id = serializers.UUIDField(allow_null=True)
    starter_origin = StarterOrigin(allow_null=True)
    submission_mode = serializers.ChoiceField(choices=["individual", "team"])
    max_attempts = serializers.IntegerField()
    max_team_size = serializers.IntegerField()
    due_at = serializers.DateTimeField(allow_null=True)


class PublishedChecks(BodySerializer):
    protocol = serializers.ChoiceField(choices=["code-along.public-checks"])
    version = serializers.IntegerField(min_value=1, max_value=1)
    language = serializers.ChoiceField(choices=["python"])
    source_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")

    def get_fields(self) -> dict[str, Any]:
        fields = super().get_fields()
        fields["source"] = serializers.CharField(trim_whitespace=False)
        return fields


class AssignmentStarterIdentity(BodySerializer):
    revision_id = serializers.UUIDField()
    manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class SubmissionPolicy(BodySerializer):
    mode = serializers.ChoiceField(choices=["individual", "team"])
    max_attempts = serializers.IntegerField()
    max_team_size = serializers.IntegerField()
    due_at = serializers.DateTimeField(allow_null=True)
    late_policy = serializers.ChoiceField(choices=["reject"])


class AssignmentVersionDetail(BodySerializer):
    id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    workspace_id = serializers.UUIDField()
    number = serializers.IntegerField()
    title = serializers.CharField()
    instructions = serializers.CharField(trim_whitespace=False)
    hints = AssignmentHint(many=True)
    published_at = serializers.DateTimeField()
    publisher = RevisionAuthor()
    starter = AssignmentStarterIdentity()
    runtime = RevisionRuntime()
    helper_release = RevisionHelper()
    public_checks = PublishedChecks(allow_null=True)
    submission_policy = SubmissionPolicy()
    content_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class AssignmentStarter(BodySerializer):
    assignment_id = serializers.UUIDField()
    assignment_version_id = serializers.UUIDField()
    revision_id = serializers.UUIDField()
    manifest = RevisionManifest()

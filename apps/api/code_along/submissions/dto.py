from drf_spectacular.utils import PolymorphicProxySerializer, extend_schema_field
from rest_framework import serializers

from code_along.common.api import BodySerializer, PageSerializer
from code_along.learning.participation_dto import LearningUser
from code_along.projects.revision_dto import (
    RevisionHelper,
    RevisionRuntime,
    RevisionSource,
)


class RunEvidence(BodySerializer):
    kind = serializers.ChoiceField(choices=["run"])
    run_id = serializers.UUIDField()
    source_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    status = serializers.ChoiceField(
        choices=["succeeded", "failed", "cancelled", "timed_out", "output_limit"]
    )


class ChecksEvidence(RunEvidence):
    kind = serializers.ChoiceField(choices=["visible_checks"])
    practice_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    published_checks_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    checks_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    check_origin = serializers.ChoiceField(choices=["published", "local_practice"])


@extend_schema_field(
    PolymorphicProxySerializer(
        component_name="ClientPracticeEvidence",
        serializers={"run": RunEvidence, "visible_checks": ChecksEvidence},
        resource_type_field_name="kind",
    )
)
class PracticeEvidenceField(serializers.JSONField):
    pass


class SubmissionSourceManifest(BodySerializer):
    version = serializers.IntegerField(min_value=2, max_value=2)
    project_id = serializers.UUIDField()
    source_kind = serializers.ChoiceField(choices=["project"])
    metadata_version = serializers.IntegerField(min_value=1, max_value=9007199254740991)
    entrypoint_file_id = serializers.UUIDField()
    runtime = RevisionRuntime()
    stdin_mode = serializers.ChoiceField(choices=["batch", "interactive"])
    files = serializers.ListField(child=RevisionSource(), min_length=1, max_length=20)
    sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class SubmissionCreate(BodySerializer):
    client_request_id = serializers.UUIDField()
    manifest = SubmissionSourceManifest()
    practice = PracticeEvidenceField(allow_null=True)


class SubmissionSummary(BodySerializer):
    id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    work_id = serializers.UUIDField()
    assignment_version_id = serializers.UUIDField()
    assignment_submission_number = serializers.IntegerField(min_value=1, max_value=256)
    submitted_at = serializers.DateTimeField()
    author = LearningUser()
    participants = LearningUser(many=True)
    client_request_id = serializers.UUIDField()
    source_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    artifact_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    artifact_scope = serializers.ChoiceField(choices=["submission"])
    provenance = serializers.ChoiceField(choices=["client_submitted_snapshot"])
    practice = PracticeEvidenceField(allow_null=True)
    can_review = serializers.BooleanField()


class SubmissionPublishedVersion(BodySerializer):
    number = serializers.IntegerField()
    title = serializers.CharField()
    content_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    submission_mode = serializers.ChoiceField(choices=["individual", "team"])


class SubmissionDetail(SubmissionSummary):
    manifest = SubmissionSourceManifest()
    helper_release = RevisionHelper()
    published_version = SubmissionPublishedVersion()


class SubmissionAvailability(BodySerializer):
    can_submit = serializers.BooleanField()
    reason = serializers.ChoiceField(
        choices=[
            "submission_work_unavailable",
            "submission_participation_unavailable",
            "submission_roster_changed",
            "submission_source_unavailable",
            "submission_runtime_changed",
            "submission_deadline_passed",
            "submission_attempt_limit",
            "assignment_submission_capacity",
            "workspace_submission_capacity",
            "assignment_submission_storage_capacity",
            "workspace_submission_storage_capacity",
        ],
        allow_null=True,
    )
    checked_at = serializers.DateTimeField()


class SubmissionPage(BodySerializer):
    items = SubmissionSummary(many=True)
    count = serializers.IntegerField(min_value=0)


class WorkSubmissionPage(SubmissionPage):
    availability = SubmissionAvailability()


class SubmissionListQuery(PageSerializer):
    assignment_version_id = serializers.UUIDField(required=False)

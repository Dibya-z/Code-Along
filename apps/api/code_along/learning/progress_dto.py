from rest_framework import serializers

from code_along.collaboration.api import StrictUUIDField
from code_along.common.api import BodySerializer, PageSerializer

from .participation_dto import LearningUser

PROGRESS_STATES = [
    "not_started",
    "in_progress",
    "submitted",
    "reviewed",
    "needs_changes",
    "complete",
]
ELIGIBILITY_STATES = [
    "not_offered",
    "invited",
    "expired",
    "declined",
    "withdrawn",
    "revoked",
    "unavailable",
    "team_pending",
    "policy_ineligible",
    "eligible",
    "archived",
]


class ProgressQuery(BodySerializer):
    assignment_version_id = StrictUUIDField()


class LearnerProgressQuery(PageSerializer):
    assignment_version_id = StrictUUIDField()


class ProgressSubmission(BodySerializer):
    id = serializers.UUIDField()
    number = serializers.IntegerField(min_value=1, max_value=256)
    submitted_at = serializers.DateTimeField()
    source_manifest_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")


class ProgressAssessment(BodySerializer):
    publication_id = serializers.UUIDField()
    assessment_status = serializers.ChoiceField(
        choices=["reviewed", "needs_changes", "complete"]
    )
    published_at = serializers.DateTimeField()
    assessment_kind = serializers.ChoiceField(choices=["manual"])


class ProgressHistory(BodySerializer):
    assignment_id = serializers.UUIDField()
    assignment_version_id = serializers.UUIDField()
    user_id = serializers.UUIDField()
    state = serializers.ChoiceField(choices=PROGRESS_STATES)
    eligibility_state = serializers.ChoiceField(choices=ELIGIBILITY_STATES)
    latest_submission = ProgressSubmission(allow_null=True)
    latest_assessment = ProgressAssessment(allow_null=True)


class OwnProgress(ProgressHistory):
    can_submit = serializers.BooleanField()


class LearnerProgressRow(ProgressHistory):
    user = LearningUser()


class LearnerProgressPage(BodySerializer):
    items = LearnerProgressRow(many=True)
    count = serializers.IntegerField(min_value=0, max_value=100)

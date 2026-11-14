from rest_framework import serializers

from code_along.collaboration.api import StrictIntegerField, StrictUUIDField
from code_along.common.api import BodySerializer
from code_along.learning.dto import ExactText
from code_along.learning.participation_dto import LearningUser


class FeedbackDraftSave(BodySerializer):
    expected_revision = StrictIntegerField(min_value=0, max_value=9007199254740991)
    comments = ExactText(byte_limit=8192)
    assessment_status = serializers.ChoiceField(
        choices=["reviewed", "needs_changes", "complete"], allow_null=True
    )


class FeedbackPublish(BodySerializer):
    expected_revision = StrictIntegerField(min_value=0, max_value=9007199254740991)
    client_request_id = StrictUUIDField()


class FeedbackDraft(BodySerializer):
    submission_id = serializers.UUIDField()
    revision = serializers.IntegerField(min_value=0, max_value=9007199254740991)
    comments = serializers.CharField(allow_blank=True, trim_whitespace=False)
    assessment_status = serializers.ChoiceField(
        choices=["reviewed", "needs_changes", "complete"], allow_null=True
    )
    last_edited_by = LearningUser(allow_null=True)
    updated_at = serializers.DateTimeField(allow_null=True)


class FeedbackPublication(BodySerializer):
    id = serializers.UUIDField()
    submission_id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    assignment_version_id = serializers.UUIDField()
    number = serializers.IntegerField(min_value=1, max_value=20)
    comments = serializers.CharField(allow_blank=True, trim_whitespace=False)
    assessment_status = serializers.ChoiceField(
        choices=["reviewed", "needs_changes", "complete"]
    )
    publisher = LearningUser()
    published_at = serializers.DateTimeField()
    content_sha256 = serializers.RegexField(r"^[a-f0-9]{64}$")
    assessment_kind = serializers.ChoiceField(choices=["manual"])


class FeedbackLatest(BodySerializer):
    latest = FeedbackPublication(allow_null=True)


class FeedbackPage(BodySerializer):
    items = FeedbackPublication(many=True)
    count = serializers.IntegerField(min_value=0, max_value=20)

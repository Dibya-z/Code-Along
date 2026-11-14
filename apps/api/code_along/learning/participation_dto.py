import re
from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ValidationError

from code_along.collaboration.api import StrictIntegerField, StrictUUIDField
from code_along.common.api import BodySerializer, PageSerializer

from .dto import AssignmentRevision, ExactText, StrictBoolean


class ParticipationOffer(BodySerializer):
    recipient_id = StrictUUIDField()
    expected_revision = StrictIntegerField(
        min_value=1, max_value=9007199254740991, required=False
    )


class TeamCreate(BodySerializer):
    name = ExactText(byte_limit=320, nonblank=True, label_limit=80)


class TeamPatch(AssignmentRevision):
    name = ExactText(byte_limit=320, nonblank=True, label_limit=80, required=False)
    archived = StrictBoolean(required=False)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if set(attrs) == {"expected_revision"}:
            raise ValidationError("Provide a name or archived state.")
        return attrs


class TeamMemberOffer(BodySerializer):
    participation_id = StrictUUIDField()
    expected_team_revision = StrictIntegerField(min_value=1, max_value=9007199254740991)
    expected_participation_revision = StrictIntegerField(
        min_value=1, max_value=9007199254740991
    )


class QueryRevision(serializers.IntegerField):
    def to_internal_value(self, data: Any) -> int:
        if not isinstance(data, str) or re.fullmatch(r"[1-9][0-9]{0,15}", data) is None:
            raise ValidationError("Use a positive decimal revision.")
        return super().to_internal_value(data)


class TeamMemberRemove(BodySerializer):
    expected_team_revision = QueryRevision(min_value=1, max_value=9007199254740991)
    expected_participation_revision = QueryRevision(
        min_value=1, max_value=9007199254740991
    )


class TeamApproval(AssignmentRevision):
    roster_revision = StrictIntegerField(min_value=1, max_value=9007199254740991)


class TeamConsent(TeamApproval):
    team_id = StrictUUIDField()


class TeamVersionQuery(BodySerializer):
    assignment_version_id = StrictUUIDField(required=False)


class TeamListQuery(PageSerializer):
    assignment_version_id = StrictUUIDField(required=False)


class WorkListQuery(PageSerializer):
    mine = serializers.ChoiceField(choices=["true", "false"], default="true")
    include_retired = serializers.ChoiceField(
        choices=["true", "false"], default="false"
    )


class WorkCreate(BodySerializer):
    client_request_id = StrictUUIDField()
    assignment_version_id = StrictUUIDField()
    expected_participation_revision = StrictIntegerField(
        min_value=1, max_value=9007199254740991
    )
    expected_team_roster_revision = StrictIntegerField(
        min_value=1, max_value=9007199254740991, allow_null=True
    )
    project_name = ExactText(byte_limit=480, nonblank=True, label_limit=120)
    sharing = serializers.ChoiceField(choices=["private", "approved_team_editors"])


class LearningUser(BodySerializer):
    id = serializers.UUIDField()
    display_name = serializers.CharField()


class TeamOffer(BodySerializer):
    team_id = serializers.UUIDField()
    name = serializers.CharField()
    roster_revision = serializers.IntegerField()
    expires_at = serializers.DateTimeField()
    consented_revision = serializers.IntegerField(allow_null=True)
    consented_at = serializers.DateTimeField(allow_null=True)


class Participation(BodySerializer):
    id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    user = LearningUser()
    state = serializers.ChoiceField(
        choices=["invited", "accepted", "declined", "withdrawn", "revoked"]
    )
    effective_state = serializers.ChoiceField(
        choices=["invited", "expired", "accepted", "declined", "withdrawn", "revoked"]
    )
    revision = serializers.IntegerField()
    invited_at = serializers.DateTimeField()
    invite_expires_at = serializers.DateTimeField()
    accepted_at = serializers.DateTimeField(allow_null=True)
    ended_at = serializers.DateTimeField(allow_null=True)
    team_offer = TeamOffer(allow_null=True)
    can_accept = serializers.BooleanField()
    can_withdraw = serializers.BooleanField()


class ParticipationPage(BodySerializer):
    items = Participation(many=True)
    count = serializers.IntegerField()


class TeamMember(BodySerializer):
    participation_id = serializers.UUIDField()
    user = LearningUser()
    consented = serializers.BooleanField()


class VersionEligibility(BodySerializer):
    assignment_version_id = serializers.UUIDField()
    submission_mode = serializers.ChoiceField(choices=["individual", "team"])
    member_count = serializers.IntegerField()
    max_team_size = serializers.IntegerField()
    eligible = serializers.BooleanField()
    reason = serializers.ChoiceField(
        choices=["mode_mismatch", "team_size"], allow_null=True
    )


class Team(BodySerializer):
    id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    name = serializers.CharField()
    revision = serializers.IntegerField()
    roster_revision = serializers.IntegerField()
    approved_roster_revision = serializers.IntegerField(allow_null=True)
    archived = serializers.BooleanField()
    consent_ready = serializers.BooleanField()
    version_eligibility = VersionEligibility(allow_null=True)
    members = TeamMember(many=True)
    created_at = serializers.DateTimeField()
    updated_at = serializers.DateTimeField()


class TeamPage(BodySerializer):
    items = Team(many=True)
    count = serializers.IntegerField()


class WorkProject(BodySerializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    role = serializers.ChoiceField(choices=["owner", "editor", "viewer"])


class Work(BodySerializer):
    id = serializers.UUIDField()
    assignment_id = serializers.UUIDField()
    assignment_version_id = serializers.UUIDField()
    subject_kind = serializers.ChoiceField(choices=["individual", "team"])
    team_id = serializers.UUIDField(allow_null=True)
    team_roster_revision = serializers.IntegerField(allow_null=True)
    state = serializers.ChoiceField(choices=["active", "retired"])
    retired_reason = serializers.ChoiceField(
        choices=[
            "participation_ended",
            "roster_changed",
            "team_archived",
            "project_unavailable",
        ],
        allow_null=True,
    )
    created_at = serializers.DateTimeField()
    can_continue = serializers.BooleanField()
    project = WorkProject(allow_null=True)


class WorkPage(BodySerializer):
    items = Work(many=True)
    count = serializers.IntegerField()

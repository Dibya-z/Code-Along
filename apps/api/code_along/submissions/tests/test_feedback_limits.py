import io
import uuid
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.sessions.models import Session
from django.core.cache import cache
from django.utils import timezone

from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.submissions import feedback_contracts as contract
from code_along.submissions.errors import SubmissionError
from code_along.submissions.models import (
    FeedbackPublication,
    InstructorFeedback,
    SubmissionAssignmentUsage,
    SubmissionWorkspaceUsage,
)
from code_along.submissions.tests.test_feedback import (
    base,
    feedback_fixture,
    publish,
    save,
)
from code_along.workspaces.models import WorkspaceMembership

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def test_reachable_publication_count_boundary_and_original_retry() -> None:
    teacher, learner, record = feedback_fixture()
    nonce = str(uuid.uuid4())
    with patch.object(contract, "MAX_PUBLICATIONS", 2):
        assert save(teacher, record, comments="", status="complete").status_code == 200
        first = publish(teacher, record, nonce=nonce)
        assert first.status_code == 201, first.content
        assert (
            save(
                teacher, record, revision=2, comments="", status="complete"
            ).status_code
            == 200
        )
        assert publish(teacher, record, revision=3).status_code == 201
        assert (
            save(
                teacher, record, revision=4, comments="retained draft after capacity"
            ).status_code
            == 200
        )
        denied = publish(teacher, record, revision=5)
        repeated = publish(teacher, record, revision=1, nonce=nonce)
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "feedback_publication_capacity"
    )
    assert "Retry-After" not in denied
    assert repeated.status_code == 200 and repeated.json() == first.json()
    assert (
        FeedbackPublication.objects.count() == 2
        and InstructorFeedback.objects.get().revision == 5
    )


@pytest.mark.parametrize("scope", ["SUBMISSION", "ASSIGNMENT", "WORKSPACE"])
def test_actual_retained_metadata_reaches_exact_lowered_boundary(scope: str) -> None:
    teacher, learner, record = feedback_fixture()
    now = timezone.now().replace(microsecond=123456)
    with patch(
        "code_along.submissions.feedback_services.timezone.now", return_value=now
    ):
        assert save(teacher, record, comments="", status="complete").status_code == 200
        assert publish(teacher, record).status_code == 201
        charge = FeedbackPublication.objects.get().metadata_bytes
        with patch.object(contract, f"MAX_{scope}_FEEDBACK_BYTES", charge * 2):
            assert (
                save(
                    teacher, record, revision=2, comments="", status="complete"
                ).status_code
                == 200
            )
            second = publish(teacher, record, revision=3)
            assert second.status_code == 201, second.content
            assert (
                save(
                    teacher, record, revision=4, comments="", status="complete"
                ).status_code
                == 200
            )
            denied = publish(teacher, record, revision=5)
    assert (
        denied.status_code == 409
        and denied.json()["code"] == "feedback_metadata_capacity"
    )
    assert "Retry-After" not in denied
    assert FeedbackPublication.objects.count() == 2
    assert (
        InstructorFeedback.objects.get().published_metadata_bytes
        == SubmissionAssignmentUsage.objects.get().feedback_metadata_bytes
        == SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes
        == charge * 2
    )
    assert learner.get(base(record) + "publications/", secure=True).json()["count"] == 2


def test_full_valid_comment_can_exceed_metadata_expansion_bound_without_truncation() -> (
    None
):
    teacher, learner, record = feedback_fixture()
    exact = "\x01" * 8192
    assert save(teacher, record, comments=exact).status_code == 200
    denied = publish(teacher, record)
    assert (
        denied.status_code == 409 and denied.json()["code"] == "feedback_metadata_limit"
    )
    draft = InstructorFeedback.objects.get()
    assert (
        draft.draft_comments == exact
        and draft.revision == 1
        and draft.current_publication_id is None
    )
    assert FeedbackPublication.objects.count() == 0
    assert SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes == 0


@pytest.mark.parametrize("target", ["publication", "pointer", "counter"])
def test_failure_rolls_back_publication_pointer_and_all_private_counters(
    target: str,
) -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    path = {
        "publication": "code_along.submissions.feedback_services.FeedbackPublication.save",
        "pointer": "code_along.submissions.feedback_services.InstructorFeedback.save",
        "counter": "code_along.submissions.feedback_services.SubmissionWorkspaceUsage.save",
    }[target]
    with (
        patch(path, side_effect=RuntimeError("owned injected feedback failure")),
        pytest.raises(RuntimeError),
    ):
        publish(teacher, record)
    draft = InstructorFeedback.objects.get()
    assert (
        draft.revision == 1
        and draft.current_publication_id is None
        and draft.published_metadata_bytes == 0
    )
    assert FeedbackPublication.objects.count() == 0
    assert (
        SubmissionAssignmentUsage.objects.get().feedback_metadata_bytes
        == SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes
        == 0
    )


@pytest.mark.parametrize("change", ["session", "password", "role"])
def test_actual_authority_revocation_during_publication_rolls_back(change: str) -> None:
    teacher, learner, record = feedback_fixture()
    assert save(teacher, record).status_code == 200
    key = teacher.session.session_key
    original = FeedbackPublication.save

    def revoke(instance: FeedbackPublication, *args: Any, **kwargs: Any) -> Any:
        result = original(instance, *args, **kwargs)
        if change == "session":
            Session.objects.filter(session_key=key).delete()
        elif change == "password":
            User.objects.filter(id=record.assignment.created_by_id).update(
                password="revoked owned test hash"
            )
        else:
            WorkspaceMembership.objects.filter(
                workspace=record.workspace, user_id=record.assignment.created_by_id
            ).update(role="learner")
        return result

    with patch.object(FeedbackPublication, "save", new=revoke):
        denied = publish(teacher, record)
    assert denied.status_code == 403, denied.content
    assert FeedbackPublication.objects.count() == 0
    draft = InstructorFeedback.objects.get()
    assert (
        draft.revision == 1
        and draft.current_publication_id is None
        and draft.published_metadata_bytes == 0
    )
    assert SubmissionWorkspaceUsage.objects.get().feedback_metadata_bytes == 0


def test_feedback_actual_body_bound_does_not_change_global_upload_limit() -> None:
    from django.conf import settings

    teacher, learner, record = feedback_fixture()
    assert settings.DATA_UPLOAD_MAX_MEMORY_SIZE == 512 * 1024
    response = teacher.generic(
        "PATCH",
        base(record) + "draft/",
        b" " * (64 * 1024 + 1),
        content_type="application/json",
        secure=True,
    )
    assert (
        response.status_code == 413
        and response.json()["code"] == "feedback_body_too_large"
    )
    assert InstructorFeedback.objects.count() == 0


def test_production_defaults_and_safe_integer_increment() -> None:
    assert (
        contract.MAX_PUBLICATIONS,
        contract.MAX_PUBLICATION_METADATA_BYTES,
        contract.MAX_SUBMISSION_FEEDBACK_BYTES,
        contract.MAX_ASSIGNMENT_FEEDBACK_BYTES,
        contract.MAX_WORKSPACE_FEEDBACK_BYTES,
    ) == (20, 16384, 131072, 8388608, 33554432)
    assert contract.increment(9007199254740990) == 9007199254740991
    with pytest.raises(SubmissionError) as error:
        contract.increment(9007199254740991)
    assert error.value.status_code == 409


@pytest.mark.parametrize("declared", [None, 0, 1])
def test_feedback_parser_bounds_actual_bytes_even_with_false_length(
    declared: int | None,
) -> None:
    class Observed(io.BytesIO):
        def read(self, size: int | None = -1) -> bytes:
            assert size == 65537
            return super().read(size)

    stream = Observed(b" " * 65538)
    with pytest.raises(SubmissionError) as error:
        contract.FeedbackJSONParser().parse(
            stream, parser_context={"content_length": declared}
        )
    assert error.value.status_code == 413 and stream.tell() == 65537

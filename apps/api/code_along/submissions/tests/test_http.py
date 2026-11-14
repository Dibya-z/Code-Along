import io
import json

import pytest
from django.core.cache import cache
from django.test import Client
from rest_framework.test import APIRequestFactory

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.projects import services as projects
from code_along.submissions.api import WorkSubmissionsView
from code_along.submissions.models import Submission
from code_along.submissions.parsers import MAX_BODY_BYTES
from code_along.submissions.tests.test_submissions import candidate, fixture, url

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def test_full_one_mib_decoded_escaped_source_crosses_old_django_limit_without_global_raise() -> (
    None
):
    from django.conf import settings

    teacher, client, assignment, work = fixture()
    project = work.project
    for number in range(7):
        project.refresh_from_db()
        projects.add_file(
            work.created_by, project.id, project.metadata_version, f"part_{number}.py"
        )
    project.refresh_from_db()
    body = candidate(work, "\x01" * 131072)
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    assert 6 * 1024 * 1024 < len(raw) <= MAX_BODY_BYTES
    assert settings.DATA_UPLOAD_MAX_MEMORY_SIZE == 512 * 1024
    response = client.post(
        url(assignment, work), raw, content_type="application/json", secure=True
    )
    assert response.status_code == 201, response.content[:500]
    record = Submission.objects.get()
    assert record.revision.source_bytes == 1024 * 1024
    assert record.revision.files.count() == 8
    assert all(file.source == "\x01" * 131072 for file in record.revision.files.all())
    assert response.json()["manifest"] == body["manifest"]


@pytest.mark.parametrize("declared", [None, "0", "1"])
def test_actual_valid_request_stream_is_read_when_length_header_is_missing_or_false(
    declared: str | None,
) -> None:
    teacher, client, assignment, work = fixture()
    body = candidate(work)
    raw = json.dumps(body).encode()
    request = APIRequestFactory(enforce_csrf_checks=False).post(
        url(assignment, work), raw, content_type="application/json", secure=True
    )
    request.user = work.created_by
    request.session = client.session
    request._stream = io.BytesIO(raw)
    if declared is None:
        request.META.pop("CONTENT_LENGTH", None)
    else:
        request.META["CONTENT_LENGTH"] = declared
    response = WorkSubmissionsView.as_view()(
        request, assignment_id=assignment.id, work_id=work.id
    )
    assert response.status_code == 201, response.data
    assert response.data["manifest"] == body["manifest"]


@pytest.mark.parametrize("charset", ["bogus-charset", "bz2_codec", "utf-16"])
def test_invalid_charset_is_rejected_without_traceback(charset: str) -> None:
    teacher, client, assignment, work = fixture()
    # Send raw HTTP bytes: Client.post tries to encode using the bogus charset
    # before constructing a request, which would never exercise the endpoint.
    response = client.generic(
        "POST",
        url(assignment, work),
        b"{}",
        content_type=f"application/json; charset={charset}",
        secure=True,
    )
    assert response.status_code in {400, 415}, response.content
    if response.status_code == 400:
        assert response.json()["code"] == "invalid_submission_request"
    else:
        assert isinstance(response.json()["detail"], str)
    assert len(response.content) < 512
    assert Submission.objects.count() == 0


def test_submission_route_keeps_real_csrf_protection() -> None:
    teacher, client, assignment, work = fixture()
    checked = Client(enforce_csrf_checks=True)
    checked.force_login(work.created_by)
    body = candidate(work)
    denied = checked.post(
        url(assignment, work), body, content_type="application/json", secure=True
    )
    assert denied.status_code == 403
    token = checked.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    accepted = checked.post(
        url(assignment, work),
        body,
        content_type="application/json",
        secure=True,
        HTTP_X_CSRFTOKEN=token,
        HTTP_ORIGIN="https://testserver",
    )
    assert accepted.status_code == 201, accepted.content

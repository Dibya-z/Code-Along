"""Private artifacts never inherit ordinary source/history/share authority."""

import copy
import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import timedelta
from typing import Any
from unittest.mock import patch

import psycopg
import pytest
from code_along.accounts.models import User
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.events.models import OutboxEvent
from code_along.learning import api as learning_api
from code_along.learning import selectors as learning_selectors
from code_along.learning.contracts import content_digest, metadata_size
from code_along.learning.models import (
    Assignment,
    AssignmentParticipation,
    AssignmentVersion,
)
from code_along.learning.tests.test_assignments import (
    publish,
    ready_assignment,
    ready_assignment_unique,
    write,
)
from code_along.projects import revision_services, share_services
from code_along.projects.models import (
    Project,
    ProjectRevision,
    RevisionFile,
    ShareGrant,
)
from code_along.projects.revision_api import RevisionCopyView
from code_along.projects.revision_contract import revision_hash, source_digest
from code_along.projects.revision_scopes import project_revisions
from code_along.projects.revision_services import revision_manifest
from code_along.projects.tests.test_history import (
    capture_response,
    create_revision,
    fixture_project,
    request_revision,
)
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.test import Client
from django.urls import resolve
from django.utils import timezone
from rest_framework.exceptions import NotFound
from rest_framework.utils.encoders import JSONEncoder

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def reviewed_catalog() -> None:
    ensure_runtime_catalog()
    cache.clear()


def private_artifact(
    reference: ProjectRevision,
    *,
    nonce: uuid.UUID | None = None,
    author: User | None = None,
) -> ProjectRevision:
    """A valid private fixture, not an application write/copy endpoint."""
    source = '\ufeff# PRIVATE_UNCHECKPOINTED_SOURCE\r\nprint("private snapshot")\r\n'
    manifest = copy.deepcopy(revision_manifest(reference))
    for file in manifest["files"]:
        file["source"] = source
        file["sha256"] = source_digest(source)[1]
    manifest["sha256"] = revision_hash(manifest)
    author = (
        author
        or User.objects.filter(email="private-artifact-author@example.test").first()
        or person("private-artifact-author")
    )
    WorkspaceMembership.objects.get_or_create(
        workspace=reference.project.workspace, user=author, defaults={"role": "learner"}
    )
    fields = {
        field.attname: getattr(reference, field.attname)
        for field in reference._meta.concrete_fields
        if field.name not in {"id", "created_at"}
    }
    fields.update(
        artifact_scope="submission",
        provenance="client_submitted_snapshot",
        author=author,
        author_id=author.id,
        author_display_name=author.display_name,
        client_request_id=nonce or uuid.uuid4(),
        name="PRIVATE_SUBMISSION_LABEL",
        manifest_sha256=manifest["sha256"],
        source_bytes=sum(
            source_digest(file["source"])[0] for file in manifest["files"]
        ),
    )
    fields.pop("author", None)
    with transaction.atomic():
        artifact = ProjectRevision.objects.create(**fields)
        RevisionFile.objects.bulk_create(
            [
                RevisionFile(
                    revision=artifact,
                    file_id=file["file_id"],
                    document_id=file["document_id"],
                    generation=file["generation"],
                    path=file["path"],
                    source=file["source"],
                    source_sha256=file["sha256"],
                    source_bytes=source_digest(file["source"])[0],
                )
                for file in manifest["files"]
            ]
        )
    return artifact


def assert_hidden(
    value: Any, artifact: ProjectRevision, *, shared_author: bool = False
) -> None:
    encoded = json.dumps(value, cls=JSONEncoder, ensure_ascii=False)
    fields = [
        str(artifact.id),
        artifact.name,
        artifact.manifest_sha256,
        "PRIVATE_UNCHECKPOINTED_SOURCE",
        json.loads(json.dumps(artifact.created_at, cls=JSONEncoder)),
    ]
    if not shared_author:
        fields += [str(artifact.author_id), artifact.author_display_name]
    for private in fields:
        assert private not in encoded


def constraint_name(error: IntegrityError) -> str | None:
    assert isinstance(error.__cause__, psycopg.Error)
    return error.__cause__.diag.constraint_name


def role_client(project: Project, owner: Client, role: str) -> Client:
    if role == "owner":
        return owner
    user = person(f"scope-{role}")
    if role != "foreign":
        WorkspaceMembership.objects.create(
            workspace=project.workspace,
            user=user,
            role="instructor" if role == "teacher" else "learner",
        )
    if role in {"editor", "viewer", "mentor"}:
        from code_along.projects.services import set_grant

        set_grant(
            project.owner,
            project.id,
            user.id,
            "editor" if role == "editor" else "viewer",
        )
    if role == "staff":
        user.is_staff = user.is_superuser = True
        user.save(update_fields=["is_staff", "is_superuser"])
    return signed_in(user)


def force_constraint(name: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(f'SET CONSTRAINTS "{name}" IMMEDIATE')


def clone_version(
    version: AssignmentVersion, artifact: ProjectRevision
) -> AssignmentVersion:
    fields = {
        field.attname: getattr(version, field.attname)
        for field in version._meta.concrete_fields
        if field.name != "id"
    }
    fields.update(
        number=version.number + 1,
        client_request_id=uuid.uuid4(),
        starter_revision_id=artifact.id,
        starter_project_id=artifact.project_id,
        starter_manifest_sha256=artifact.manifest_sha256,
    )
    result = AssignmentVersion(**fields)
    result.content_sha256 = content_digest(result)
    result.metadata_bytes = metadata_size(result)
    result.save(force_insert=True)
    return result


@pytest.mark.parametrize(
    "role", ["owner", "editor", "viewer", "mentor", "teacher", "staff", "foreign"]
)
def test_ordinary_source_and_teaching_roles_cannot_disclose_known_private_artifacts(
    role: str,
) -> None:
    project, owner = fixture_project()
    public = create_revision(project, owner)
    artifact = private_artifact(public)
    client = role_client(project, owner, role)
    base = f"/api/v1/projects/{project.id}"
    private_copy = f"{base}/revisions/{artifact.id}/copies/"
    assert getattr(resolve(private_copy).func, "view_class", None) is RevisionCopyView
    listing = client.get(f"{base}/revisions/", secure=True)
    if role in {"owner", "editor", "viewer", "mentor"}:
        assert listing.status_code == 200 and listing.json()["count"] == 1
        assert listing.json()["items"][0]["id"] == str(public.id)
    else:
        assert listing.status_code == 404
    assert_hidden(listing.json(), artifact)
    for response in [
        client.get(f"{base}/revisions/{artifact.id}/", secure=True),
        write(
            client,
            private_copy,
            {"name": "Attempted public copy"},
        ),
        write(
            client,
            f"{base}/shares/",
            {
                "kind": "snapshot",
                "scope": "read",
                "revision_id": str(artifact.id),
                "recipient_id": None,
                "expires_hours": 1,
            },
        ),
    ]:
        assert response.status_code in {403, 404}, response.content
        assert_hidden(response.json(), artifact)
    assert Project.objects.count() == 1 and ShareGrant.objects.count() == 0
    if role in {"owner", "editor", "viewer", "mentor"}:
        copied = write(
            client,
            f"{base}/revisions/{public.id}/copies/",
            {"name": "Authorized public copy"},
        )
        assert copied.status_code == 201, copied.content
        assert copied.json()["id"] != str(project.id)
        assert (
            Project.objects.get(id=copied.json()["id"]).files.get().initial_source
            == revision_manifest(public)["files"][0]["source"]
        )
        assert_hidden(copied.json(), artifact)
    # The serializer itself remains reusable only after separate private authorization.
    assert revision_manifest(artifact)["files"][0]["source"].startswith(
        "\ufeff# PRIVATE_"
    )


def test_public_and_private_nonce_namespaces_counts_bytes_and_events_are_independent() -> (
    None
):
    project, owner = fixture_project()
    public = create_revision(project, owner)
    before_events = OutboxEvent.objects.count()
    private = private_artifact(
        public, nonce=public.client_request_id, author=project.owner
    )
    fresh_nonce = uuid.uuid4()
    other = private_artifact(public, nonce=fresh_nonce, author=project.owner)
    assert OutboxEvent.objects.count() == before_events
    original = revision_services.existing_request(
        project,
        project.owner,
        public.client_request_id,
        public.name,
        public.metadata_version,
    )
    assert original is not None and original.id == public.id
    request = {
        "name": "Second public capture",
        "expected_version": project.metadata_version,
        "client_request_id": str(fresh_nonce),
    }
    with (
        patch.object(revision_services, "MAX_REVISIONS", 2),
        patch.object(revision_services, "MAX_REVISION_BYTES", 2 * public.source_bytes),
        patch.object(
            revision_services,
            "post_control",
            side_effect=lambda path, described, **options: capture_response(described),
        ),
    ):
        created = request_revision(owner, project, request)
        assert created.status_code == 201, created.content
        retried = request_revision(owner, project, request)
    assert retried.status_code == 200 and retried.json()["id"] == created.json()["id"]
    assert ProjectRevision.objects.filter(project=project).count() == 4
    assert project_revisions().filter(project=project).count() == 2
    assert set(
        ProjectRevision.objects.filter(
            project=project, client_request_id=fresh_nonce
        ).values_list("artifact_scope", flat=True)
    ) == {"project", "submission"}
    listing = owner.get(f"/api/v1/projects/{project.id}/revisions/", secure=True).json()
    assert listing["count"] == 2
    assert_hidden(listing, private, shared_author=True)
    assert_hidden(listing, other, shared_author=True)


@pytest.mark.parametrize(
    "scope,provenance,version",
    [
        ("project", "client_submitted_snapshot", 1),
        ("submission", "shared_room_capture", 1),
        ("other", "shared_room_capture", 1),
        ("submission", "client_submitted_snapshot", 2),
    ],
)
def test_database_requires_exact_artifact_provenance_scope_pairs(
    scope: str, provenance: str, version: int
) -> None:
    project, owner = fixture_project()
    public = create_revision(project, owner)
    fields = {
        field.attname: getattr(public, field.attname)
        for field in public._meta.concrete_fields
        if field.name not in {"id", "created_at"}
    }
    fields.update(
        artifact_scope=scope,
        provenance=provenance,
        manifest_version=version,
        client_request_id=uuid.uuid4(),
    )
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        ProjectRevision.objects.create(**fields)
    assert constraint_name(error.value) == "revision_provenance_version"


def test_direct_share_and_assignment_links_cannot_target_a_private_revision() -> None:
    project, teacher, assignment = ready_assignment()
    result = publish(teacher, assignment)
    assert result.status_code == 201
    version = AssignmentVersion.objects.get(id=result.json()["id"])
    artifact = private_artifact(version.starter_revision)
    shared, _ = share_services.create_share(
        project.owner,
        project.id,
        kind="snapshot",
        scope="read",
        revision_id=version.starter_revision_id,
        recipient_id=None,
        expires_hours=1,
    )
    actions: list[tuple[str, Callable[[], object]]] = [
        (
            "share_revision_artifact_scope",
            lambda: ShareGrant.objects.create(
                project=project,
                revision=artifact,
                revision_scope="project",
                created_by=project.owner,
                kind="snapshot",
                scope="read",
                token_digest="0" * 64,
                expires_at=timezone.now() + timedelta(hours=1),
            ),
        ),
        (
            "share_revision_artifact_scope",
            lambda: ShareGrant.objects.filter(id=shared.id).update(revision=artifact),
        ),
        (
            "assignment_draft_revision_scope",
            lambda: Assignment.objects.filter(id=assignment.id).update(
                draft_starter_revision=artifact
            ),
        ),
        ("assignment_version_revision_scope", lambda: clone_version(version, artifact)),
    ]
    for constraint, action in actions:
        with pytest.raises(IntegrityError) as error, transaction.atomic():
            action()
            force_constraint(constraint)
        assert constraint_name(error.value) == constraint
    constants: list[tuple[str, Callable[[], object]]] = [
        (
            "share_revision_public_scope",
            lambda: ShareGrant.objects.filter(id=shared.id).update(
                revision_scope="submission"
            ),
        ),
        (
            "assignment_draft_public_scope",
            lambda: Assignment.objects.filter(id=assignment.id).update(
                draft_starter_scope="submission"
            ),
        ),
    ]
    for constraint, action in constants:
        with pytest.raises(IntegrityError) as error, transaction.atomic():
            action()
        assert constraint_name(error.value) == constraint
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        wrong = copy.copy(version)
        wrong.pk = uuid.uuid4()
        wrong.number += 1
        wrong.client_request_id = uuid.uuid4()
        wrong.starter_scope = "submission"
        wrong.save(force_insert=True)
    assert constraint_name(error.value) == "assignment_version_public_scope"


def test_pending_invalid_snapshot_targets_are_hidden_from_resolve_list_and_capacity() -> (
    None
):
    project, owner = fixture_project()
    public = create_revision(project, owner)
    artifact = private_artifact(public)
    token = "a" * 43
    with pytest.raises(IntegrityError), transaction.atomic():
        ShareGrant.objects.bulk_create(
            [
                ShareGrant(
                    project=project,
                    revision=artifact,
                    revision_scope="project",
                    created_by=project.owner,
                    kind="snapshot",
                    scope="read",
                    token_digest=hashlib.sha256(
                        (token if n == 0 else str(n)).encode()
                    ).hexdigest(),
                    expires_at=timezone.now() + timedelta(hours=1),
                )
                for n in range(100)
            ]
        )
        assert owner.get(
            f"/api/v1/projects/{project.id}/shares/", secure=True
        ).json() == {"items": [], "count": 0}
        with patch.object(
            Project.objects,
            "select_for_update",
            side_effect=AssertionError("No live-source lookup for private target"),
        ):
            response = owner.post(
                "/api/v1/shares/resolve/",
                {"token": token},
                content_type="application/json",
                secure=True,
                HTTP_ORIGIN="https://testserver",
            )
        assert response.status_code == 403
        assert_hidden(response.json(), artifact)
        made = write(
            owner,
            f"/api/v1/projects/{project.id}/shares/",
            {
                "kind": "snapshot",
                "scope": "read",
                "revision_id": str(public.id),
                "recipient_id": None,
                "expires_hours": 1,
            },
        )
        assert made.status_code == 201, made.content
        assert (
            owner.get(f"/api/v1/projects/{project.id}/shares/", secure=True).json()[
                "count"
            ]
            == 1
        )
        force_constraint("share_revision_artifact_scope")
    assert ShareGrant.objects.count() == 0


def test_private_starters_are_denied_by_public_authoring_and_defensive_draft_guards() -> (
    None
):
    project, teacher, assignment = ready_assignment()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    version = assignment.current_version
    assert version is not None
    artifact = private_artifact(version.starter_revision)
    base = f"/api/v1/assignments/{assignment.id}"
    changed = write(
        teacher,
        f"{base}/draft/",
        {
            "expected_revision": assignment.revision,
            "starter_revision_id": str(artifact.id),
        },
        method="patch",
    )
    assert changed.status_code == 404
    with pytest.raises(IntegrityError), transaction.atomic():
        Assignment.objects.filter(id=assignment.id).update(
            draft_starter_revision=artifact
        )
        assert teacher.get(f"{base}/draft/", secure=True).status_code == 404
        assert (
            teacher.get(
                f"/api/v1/workspaces/{project.workspace_id}/assignments/", secure=True
            ).json()["count"]
            == 0
        )
        bad = Assignment.objects.get(id=assignment.id)
        with pytest.raises(NotFound):
            learning_api.draft_data(bad)
        force_constraint("assignment_draft_revision_scope")


def test_private_version_current_summary_lists_and_work_copy_fail_closed_before_serialization() -> (
    None
):
    project, teacher, assignment = ready_assignment()
    assert publish(teacher, assignment).status_code == 201
    assignment.refresh_from_db()
    version = assignment.current_version
    assert version is not None
    artifact = private_artifact(version.starter_revision)
    participant = AssignmentParticipation.objects.create(
        assignment=assignment,
        workspace=assignment.workspace,
        user=project.owner,
        invited_by=project.owner,
        state="accepted",
        accepted_at=timezone.now(),
    )
    base = f"/api/v1/assignments/{assignment.id}"
    count = Project.objects.count()
    with pytest.raises(IntegrityError), transaction.atomic():
        malformed = clone_version(version, artifact)
        Assignment.objects.filter(id=assignment.id).update(current_version=malformed)
        assert teacher.get(f"{base}/", secure=True).status_code == 404
        listing = teacher.get(f"{base}/versions/", secure=True)
        assert (
            listing.status_code == 404
        )  # Invalid current version hides the assignment itself.
        Assignment.objects.filter(id=assignment.id).update(current_version=version)
        listing = teacher.get(f"{base}/versions/", secure=True)
        assert listing.status_code == 200 and listing.json()["count"] == 1
        assert_hidden(listing.json(), artifact)
        assert (
            teacher.get(f"{base}/versions/{malformed.id}/", secure=True).status_code
            == 404
        )
        assert (
            teacher.get(
                f"{base}/versions/{malformed.id}/starter/", secure=True
            ).status_code
            == 404
        )
        response = write(
            teacher,
            f"{base}/works/",
            {
                "client_request_id": str(uuid.uuid4()),
                "assignment_version_id": str(malformed.id),
                "expected_participation_revision": participant.revision,
                "expected_team_roster_revision": None,
                "project_name": "Must not copy private starter",
                "sharing": "private",
            },
        )
        assert response.status_code == 404 and Project.objects.count() == count
        serializers: list[Callable[[AssignmentVersion], object]] = [
            learning_api.version_data,
            learning_api.version_summary,
            learning_selectors.require_public_version,
        ]
        for serializer in serializers:
            with pytest.raises(NotFound):
                serializer(malformed)
        force_constraint("assignment_version_revision_scope")


def test_artifact_scope_is_not_a_public_request_or_response_field() -> None:
    project, owner = fixture_project()
    public = create_revision(project, owner)
    response = request_revision(
        owner,
        project,
        {
            "name": "Scope injection",
            "expected_version": project.metadata_version,
            "client_request_id": str(uuid.uuid4()),
            "artifact_scope": "submission",
        },
    )
    assert response.status_code == 400
    response = write(
        owner,
        f"/api/v1/projects/{project.id}/shares/",
        {
            "kind": "snapshot",
            "scope": "read",
            "revision_id": str(public.id),
            "revision_scope": "submission",
            "recipient_id": None,
            "expires_hours": 1,
        },
    )
    assert response.status_code == 400
    listing = owner.get(f"/api/v1/projects/{project.id}/revisions/", secure=True).json()
    assert "artifact_scope" not in str(listing) and {
        item["provenance"] for item in listing["items"]
    } == {"shared_room_capture"}


def test_scope_fks_bind_project_identity_even_for_two_public_revisions() -> None:
    project, _, assignment = ready_assignment()
    _, _, foreign = ready_assignment_unique()
    revision = foreign.draft_starter_revision
    assert revision is not None
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        ShareGrant.objects.create(
            project=project,
            revision=revision,
            revision_scope="project",
            created_by=project.owner,
            kind="snapshot",
            scope="read",
            token_digest="b" * 64,
            expires_at=timezone.now() + timedelta(hours=1),
        )
        force_constraint("share_revision_artifact_scope")
    assert constraint_name(error.value) == "share_revision_artifact_scope"
    with pytest.raises(IntegrityError) as error, transaction.atomic():
        Assignment.objects.filter(id=assignment.id).update(
            draft_starter_revision=revision
        )
        force_constraint("assignment_draft_revision_scope")
    assert constraint_name(error.value) == "assignment_draft_revision_scope"


def test_scope_is_immutable_and_private_file_bytes_are_not_retagged_or_rewritten() -> (
    None
):
    project, owner = fixture_project()
    artifact = private_artifact(create_revision(project, owner))
    before = revision_manifest(artifact)
    with (
        pytest.raises(IntegrityError, match="Immutable revision"),
        transaction.atomic(),
    ):
        ProjectRevision.objects.filter(id=artifact.id).update(
            artifact_scope="project", provenance="shared_room_capture"
        )
    with (
        pytest.raises(IntegrityError, match="Immutable revision"),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "DELETE FROM public.projects_revisionfile WHERE revision_id=%s",
            [artifact.id],
        )
    artifact.refresh_from_db()
    assert (
        artifact.artifact_scope == "submission"
        and artifact.provenance == "client_submitted_snapshot"
    )
    assert revision_manifest(artifact) == before


def test_explicit_public_snapshot_and_live_capabilities_never_authorize_private_history() -> (
    None
):
    project, owner = fixture_project()
    public = create_revision(project, owner)
    private = private_artifact(public)
    _, snapshot = share_services.create_share(
        project.owner,
        project.id,
        kind="snapshot",
        scope="read",
        revision_id=public.id,
        recipient_id=None,
        expires_hours=1,
    )
    response = Client().post(
        "/api/v1/shares/resolve/",
        {"token": snapshot},
        content_type="application/json",
        secure=True,
        HTTP_ORIGIN="https://testserver",
    )
    assert response.status_code == 200 and response.json()["revision"]["id"] == str(
        public.id
    )
    assert_hidden(response.json(), private)
    holder = person("scope-capability")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=holder, role="learner"
    )
    client = signed_in(holder)
    _, live = share_services.create_share(
        project.owner,
        project.id,
        kind="live",
        scope="read",
        revision_id=None,
        recipient_id=None,
        expires_hours=1,
    )
    response = client.post(
        "/api/v1/shares/resolve/",
        {"token": live},
        content_type="application/json",
        secure=True,
        HTTP_ORIGIN="https://testserver",
    )
    assert response.status_code == 200 and response.json()["kind"] == "live"
    assert_hidden(response.json(), private)
    assert (
        client.get(f"/api/v1/projects/{project.id}/revisions/", secure=True).status_code
        == 404
    )
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/revisions/{private.id}/", secure=True
        ).status_code
        == 404
    )

import copy
import uuid
from collections.abc import Callable
from typing import Any
from unittest.mock import patch

import pytest
from code_along.projects import revision_dto, revision_services, services
from code_along.projects.models import Project, ProjectRevision, RevisionFile
from code_along.projects.revision_contract import revision_hash, source_digest
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.test import Client

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def reset_limits() -> None:
    cache.clear()


def fixture_project() -> tuple[Project, Client]:
    owner = person("history-owner")
    workspace = workspaces.create_workspace(owner, "History group")
    return services.create_project(owner, workspace.id, "History project"), signed_in(
        owner
    )


def capture_response(described: dict[str, Any], **_: Any) -> dict[str, Any]:
    manifest = {
        key: copy.deepcopy(described[key])
        for key in (
            "project_id",
            "metadata_version",
            "entrypoint_file_id",
            "runtime",
            "helper_release",
        )
    }
    manifest.update(protocol="code-along.revision", version=1)
    manifest["files"] = [
        {
            "file_id": file["file_id"],
            "document_id": file["document_id"],
            "generation": file["generation"],
            "path": file["path"],
            "source": '# frozen live 🐍\r\nprint("revision")\r\n',
            "sha256": source_digest('# frozen live 🐍\r\nprint("revision")\r\n')[1],
        }
        for file in described["files"]
    ]
    manifest["sha256"] = revision_hash(manifest)
    return {"version": 1, "capture_id": described["capture_id"], "manifest": manifest}


def request_revision(
    client: Client, project: Project, body: dict[str, Any] | None = None
) -> Any:
    return client.post(
        f"/api/v1/projects/{project.id}/revisions/",
        body
        or {
            "name": "A named moment",
            "expected_version": project.metadata_version,
            "client_request_id": str(uuid.uuid4()),
        },
        content_type="application/json",
        secure=True,
    )


def create_revision(project: Project, client: Client) -> ProjectRevision:
    with patch.object(
        revision_services,
        "post_control",
        side_effect=lambda path, described, **options: capture_response(described),
    ):
        response = request_revision(client, project)
    assert response.status_code == 201, response.content
    return ProjectRevision.objects.get(id=response.json()["id"])


def test_named_revision_retains_exact_frozen_bytes_and_copy_gets_independent_identities() -> (
    None
):
    project, client = fixture_project()
    revision = create_revision(project, client)
    original = project.files.get()
    frozen = '# frozen live 🐍\r\nprint("revision")\r\n'
    assert original.initial_source != frozen  # No REST live-save path was created.
    services.rename_file(project.owner, project.id, original.id, 1, "renamed.py")
    response = client.get(
        f"/api/v1/projects/{project.id}/revisions/{revision.id}/", secure=True
    )
    assert response.status_code == 200
    body = response.json()
    dto = revision_dto.RevisionDetail(data=body)
    assert dto.is_valid(), dto.errors
    assert body["manifest"]["files"][0]["path"] == "main.py"
    assert body["manifest"]["files"][0]["source"] == frozen
    assert body["manifest"]["sha256"] == revision.manifest_sha256
    copied = client.post(
        f"/api/v1/projects/{project.id}/revisions/{revision.id}/copies/",
        {"name": "New independent copy"},
        content_type="application/json",
        secure=True,
    )
    assert copied.status_code == 201
    copy_project = Project.objects.get(id=copied.json()["id"])
    copy_file = copy_project.files.get()
    assert copy_project.id != project.id and copy_project.owner_id == project.owner_id
    assert copy_file.id != original.id and copy_file.document.id != original.document.id
    assert copy_file.initial_source == frozen and copy_file.path == "main.py"
    assert copy_file.generation == copy_file.document.generation == 1


def test_committed_nonce_returns_original_after_current_auth_and_conflicts_if_payload_changes() -> (
    None
):
    project, client = fixture_project()
    request = {
        "name": "Original name",
        "expected_version": 1,
        "client_request_id": str(uuid.uuid4()),
    }
    with patch.object(
        revision_services,
        "post_control",
        side_effect=lambda path, described, **options: capture_response(described),
    ) as capture:
        created = request_revision(client, project, request)
        assert created.status_code == 201
        services.update_project(project.owner, project.id, 1, name="Later metadata")
        retry = request_revision(client, project, request)
        assert retry.status_code == 200 and retry.json() == created.json()
        assert capture.call_count == 1
        for changed in (
            {**request, "name": "Another name"},
            {**request, "expected_version": 2},
        ):
            assert request_revision(client, project, changed).status_code == 409
        project.owner.set_password("new-password-orbit-river-63!")
        project.owner.save(update_fields=["password"])
        assert request_revision(client, project, request).status_code == 403
    assert ProjectRevision.objects.count() == 1


@pytest.mark.parametrize(
    "mutation", ["project", "document", "file", "runtime", "helper", "extra_file"]
)
def test_captured_source_is_not_returned_or_committed_when_bindings_do_not_match(
    mutation: str,
) -> None:
    project, client = fixture_project()

    def bad(path: str, described: dict[str, Any], **options: Any) -> dict[str, Any]:
        result = capture_response(described)
        manifest = result["manifest"]
        if mutation == "project":
            manifest["project_id"] = str(uuid.uuid4())
        elif mutation == "document":
            manifest["files"][0]["document_id"] = str(uuid.uuid4())
        elif mutation == "file":
            manifest["files"][0]["file_id"] = manifest["entrypoint_file_id"] = str(
                uuid.uuid4()
            )
        elif mutation == "runtime":
            manifest["runtime"]["python_version"] = "0.0.0"
        elif mutation == "helper":
            manifest["helper_release"]["source_sha256"] = "0" * 64
        else:
            extra = {
                **manifest["files"][0],
                "file_id": str(uuid.uuid4()),
                "document_id": str(uuid.uuid4()),
                "path": "other.py",
            }
            manifest["files"].append(extra)
        manifest["sha256"] = revision_hash(manifest)
        return result

    with patch.object(revision_services, "post_control", side_effect=bad):
        response = request_revision(client, project)
    assert response.status_code == 503
    assert "frozen live" not in response.content.decode()
    assert not ProjectRevision.objects.exists() and not RevisionFile.objects.exists()


@pytest.mark.parametrize(
    "race", ["rename", "membership", "password", "logout", "runtime"]
)
def test_post_capture_commit_rechecks_metadata_permission_session_and_runtime(
    race: str,
) -> None:
    project, client = fixture_project()

    def changed(path: str, described: dict[str, Any], **options: Any) -> dict[str, Any]:
        result = capture_response(described)
        if race == "rename":
            services.rename_file(
                project.owner, project.id, project.entrypoint_file_id, 1, "changed.py"
            )
        elif race == "membership":
            WorkspaceMembership.objects.filter(workspace=project.workspace).update(
                active=False
            )
        elif race == "password":
            project.owner.set_password("different-auth-hash-river-orbit-42!")
            project.owner.save(update_fields=["password"])
        elif race == "logout":
            client.logout()
        else:
            profile = project.runtime_profile
            profile.manifest = {**profile.manifest, "version_pin": "unreviewed"}
            profile.save(update_fields=["manifest"])
        return result

    with patch.object(revision_services, "post_control", side_effect=changed):
        response = request_revision(client, project)
    assert response.status_code in {403, 404, 409, 503}
    assert "frozen live" not in response.content.decode()
    assert not ProjectRevision.objects.exists()


@pytest.mark.django_db(transaction=True)
def test_capture_does_not_hold_workspace_or_project_transaction_across_network_io() -> (
    None
):
    project, client = fixture_project()

    def outside(path: str, described: dict[str, Any], **options: Any) -> dict[str, Any]:
        assert not connection.in_atomic_block
        return capture_response(described)

    with patch.object(revision_services, "post_control", side_effect=outside):
        assert request_revision(client, project).status_code == 201


def test_revision_and_file_rows_are_database_immutable_and_entrypoint_is_a_member() -> (
    None
):
    project, client = fixture_project()
    revision = create_revision(project, client)
    changes: tuple[Callable[[], int], ...] = (
        lambda: ProjectRevision.objects.filter(id=revision.id).update(name="Changed"),
        lambda: revision.files.update(source="Changed"),
    )
    for change in changes:
        with pytest.raises(IntegrityError), transaction.atomic():
            change()
    with (
        pytest.raises(IntegrityError),
        transaction.atomic(),
        connection.cursor() as cursor,
    ):
        cursor.execute(
            "DELETE FROM projects_revisionfile WHERE revision_id=%s", [revision.id]
        )
    assert revision.files.get().source.startswith("# frozen live")
    with pytest.raises(IntegrityError), transaction.atomic():
        ProjectRevision.objects.create(
            project=project,
            author=project.owner,
            author_display_name="Owner",
            client_request_id=uuid.uuid4(),
            name="Missing entrypoint",
            manifest_sha256=revision.manifest_sha256,
            metadata_version=1,
            entrypoint_file_id=uuid.uuid4(),
            runtime_profile=revision.runtime_profile,
            runtime_identity=revision.runtime_identity,
            runtime_manifest=revision.runtime_manifest,
            helper_release=revision.helper_release,
            source_bytes=0,
        )
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_viewer_can_read_and_copy_history_but_cannot_create_shared_revision() -> None:
    project, owner = fixture_project()
    revision = create_revision(project, owner)
    viewer = person("history-viewer")
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=viewer, role="learner"
    )
    services.set_grant(project.owner, project.id, viewer.id, "viewer")
    client = signed_in(viewer)
    base = f"/api/v1/projects/{project.id}/revisions/"
    assert client.get(base, secure=True).status_code == 200
    assert client.get(base + f"{revision.id}/", secure=True).status_code == 200
    assert request_revision(client, project).status_code == 403
    assert (
        client.post(
            base + f"{revision.id}/copies/",
            {"name": "Viewer copy"},
            content_type="application/json",
            secure=True,
        ).status_code
        == 201
    )


def test_revision_storage_limit_fails_without_partial_rows() -> None:
    project, client = fixture_project()
    create_revision(project, client)
    with (
        patch.object(revision_services, "MAX_REVISIONS", 1),
        patch.object(
            revision_services,
            "post_control",
            side_effect=lambda path, described, **options: capture_response(described),
        ),
    ):
        assert request_revision(client, project).status_code == 429
    assert ProjectRevision.objects.count() == 1 and RevisionFile.objects.count() == 1


def test_capture_and_history_sort_paths_independently_of_database_collation() -> None:
    project, client = fixture_project()
    for version, path in enumerate(["Z.py", "_helpers.py", "a.py"], start=1):
        services.add_file(project.owner, project.id, version, path)
    project.refresh_from_db()
    reversed_files = project.files.filter(deleted_at__isnull=True).order_by("-path")
    with patch.object(type(project.files), "filter", return_value=reversed_files):
        described = revision_services.descriptor(project)
    assert [file["path"] for file in described["files"]] == [
        "Z.py",
        "_helpers.py",
        "a.py",
        "main.py",
    ]
    revision = create_revision(project, client)
    reversed_snapshot = revision.files.all().order_by("-path")
    with patch.object(type(revision.files), "all", return_value=reversed_snapshot):
        manifest = revision_services.revision_manifest(revision)
    assert [file["path"] for file in manifest["files"]] == [
        "Z.py",
        "_helpers.py",
        "a.py",
        "main.py",
    ]

import hashlib
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest
from code_along.projects import services
from code_along.projects.models import (
    CollaborationDocument,
    Project,
    ProjectAccess,
    ProjectFile,
)
from code_along.projects.runtime_catalog import PROFILE_ID
from code_along.workspaces import services as workspaces
from code_along.workspaces.models import WorkspaceMembership as Membership
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.db import IntegrityError, close_old_connections, connection, transaction
from rest_framework.exceptions import NotFound, ValidationError

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


def test_project_creation_seeds_atomic_file_document_and_frozen_runtime() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Hello Python")
    file = project.files.get()
    document = project.documents.get()
    assert file.path == "main.py" and project.entrypoint_file_id == file.id
    assert document.file_id == file.id and document.generation == file.generation == 1
    assert document.schema_version == 1 and document.project == project
    assert (
        file.initial_sha256 == hashlib.sha256(file.initial_source.encode()).hexdigest()
    )
    assert project.runtime_profile_id == PROFILE_ID
    assert not ProjectAccess.objects.exists()
    payload = signed_in(owner).get(f"/api/v1/projects/{project.id}/").json()
    assert payload["role"] == "owner" and payload["metadata_version"] == 1


def test_failed_seed_rolls_back_project_and_file() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    with (
        patch.object(
            CollaborationDocument.objects,
            "create",
            side_effect=RuntimeError("owned fault"),
        ),
        pytest.raises(RuntimeError),
    ):
        services.create_project(owner, workspace.id, "Broken")
    assert not Project.objects.exists() and not ProjectFile.objects.exists()


@pytest.mark.parametrize("role", ["owner", "instructor", "learner"])
def test_workspace_roles_never_grant_private_project_access(role: str) -> None:
    creator = person("creator")
    other = person("other")
    workspace = workspaces.create_workspace(creator, "Group")
    Membership.objects.create(workspace=workspace, user=other, role="learner")
    project = services.create_project(other, workspace.id, "Private")
    if role != "owner":
        workspaces.transfer_ownership(creator, workspace.id, other.id)
        Membership.objects.filter(workspace=workspace, user=creator).update(role=role)
    client = signed_in(creator)
    assert (
        client.get(f"/api/v1/workspaces/{workspace.id}/projects/").json()["items"] == []
    )
    assert client.get(f"/api/v1/projects/{project.id}/").status_code == 404
    assert (
        client.get(
            f"/api/v1/projects/{project.id}/files/{project.entrypoint_file_id}/"
        ).status_code
        == 404
    )


@pytest.mark.parametrize("role", ["editor", "viewer"])
def test_explicit_grants_control_read_write_and_management(role: str) -> None:
    owner = person("owner")
    member = person("member")
    workspace = workspaces.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    project = services.create_project(owner, workspace.id, "Project")
    services.set_grant(owner, project.id, member.id, role)
    client = signed_in(member)
    base = f"/api/v1/projects/{project.id}/"
    assert client.get(base).json()["role"] == role
    assert client.post(
        base + "files/",
        {"path": "helper.py", "expected_version": 1},
        content_type="application/json",
    ).status_code == (201 if role == "editor" else 403)
    assert (
        client.patch(
            base, {"name": "No", "expected_version": 1}, content_type="application/json"
        ).status_code
        == 403
    )
    assert (
        client.put(
            base + f"grants/{owner.id}/",
            {"role": "editor"},
            content_type="application/json",
        ).status_code
        == 403
    )
    services.revoke_grant(owner, project.id, member.id)
    assert client.get(base).status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "../bad.py",
        "/bad.py",
        "a/../bad.py",
        "a\\bad.py",
        "a//bad.py",
        "bad.txt",
        "bad.py/child.py",
        "bad-name.py",
        "bad\x00.py",
        "a/./b.py",
    ],
)
def test_file_paths_reject_traversal_and_ambiguous_modules(path: str) -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 1, path)
    assert project.files.count() == 1


def test_case_import_collisions_rename_entrypoint_and_soft_delete() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 1, "MAIN.py")
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 1, "main/helper.py")
    file = services.add_file(
        owner, project.id, 1, "lessons/helper.py", "print('hello')\n"
    )
    document = file.document.id
    services.rename_file(owner, project.id, file.id, 2, "lessons/greeting.py")
    file.refresh_from_db()
    assert file.document.id == document and file.generation == 1
    with pytest.raises(ValidationError):
        services.delete_file(owner, project.id, project.entrypoint_file_id, 3)
    services.update_project(owner, project.id, 3, entrypoint_file_id=file.id)
    services.delete_file(owner, project.id, project.entrypoint_file_id, 4)
    project.refresh_from_db()
    assert project.metadata_version == 5
    assert (
        project.files.count() == 2
        and project.files.filter(deleted_at__isnull=True).count() == 1
    )
    assert project.documents.count() == 2


@pytest.mark.parametrize(
    "source",
    ["bad\x00source", "x" * (128 * 1024 + 1), "\ud800"],
    ids=["nul", "oversize", "surrogate"],
)
def test_source_size_and_encoding_are_bounded(source: str) -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 1, "helper.py", source)


def test_file_count_and_total_source_quotas() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    for index in range(19):
        services.add_file(owner, project.id, index + 1, f"file_{index}.py")
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 20, "overflow.py")
    large = services.create_project(owner, workspace.id, "Large")
    for index in range(7):
        services.add_file(
            owner, large.id, index + 1, f"file_{index}.py", "x" * (128 * 1024)
        )
    with pytest.raises(ValidationError):
        services.add_file(owner, large.id, 8, "overflow.py", "x" * (128 * 1024))


def test_nested_file_ids_cannot_reference_another_project() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    one = services.create_project(owner, workspace.id, "One")
    two = services.create_project(owner, workspace.id, "Two")
    with pytest.raises(NotFound):
        services.rename_file(owner, one.id, two.entrypoint_file_id, 1, "stolen.py")
    with pytest.raises(NotFound):
        services.update_project(
            owner, one.id, 1, entrypoint_file_id=two.entrypoint_file_id
        )
    assert (
        signed_in(owner)
        .get(f"/api/v1/projects/{one.id}/files/{two.entrypoint_file_id}/")
        .status_code
        == 404
    )


def test_database_enforces_entrypoint_document_project_and_generation_pairs() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    one = services.create_project(owner, workspace.id, "One")
    two = services.create_project(owner, workspace.id, "Two")

    def force_constraints() -> None:
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    with pytest.raises(IntegrityError), transaction.atomic():
        Project.objects.filter(id=one.id).update(
            entrypoint_file_id=two.entrypoint_file_id
        )
        force_constraints()
    with pytest.raises(IntegrityError), transaction.atomic():
        CollaborationDocument.objects.filter(project=one).update(project=two)
        force_constraints()
    with pytest.raises(IntegrityError), transaction.atomic():
        CollaborationDocument.objects.filter(project=one).update(generation=2)
        force_constraints()


def test_membership_removal_requires_project_transfer_and_clears_other_grants() -> None:
    owner = person("owner")
    member = person("member")
    workspace = workspaces.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    owned = services.create_project(member, workspace.id, "Owned")
    shared = services.create_project(owner, workspace.id, "Shared")
    services.set_grant(owner, shared.id, member.id, "viewer")
    with pytest.raises(ValidationError):
        workspaces.update_member(owner, workspace.id, member.id, remove=True)
    services.transfer_project(member, owned.id, owner.id, 1)
    assert not ProjectAccess.objects.filter(project=owned, user=owner).exists()
    assert ProjectAccess.objects.get(project=owned, user=member).role == "editor"
    workspaces.update_member(owner, workspace.id, member.id, remove=True)
    assert not ProjectAccess.objects.filter(
        user=member, project__workspace=workspace
    ).exists()
    assert signed_in(member).get(f"/api/v1/projects/{shared.id}/").status_code == 404


def test_only_active_same_workspace_members_can_receive_grants() -> None:
    owner = person("owner")
    other = person("other")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    with pytest.raises(ValidationError):
        services.set_grant(owner, project.id, other.id, "viewer")
    with pytest.raises(ValidationError):
        services.set_grant(owner, project.id, owner.id, "viewer")


def test_archives_and_stale_metadata_are_rejected_without_mutation() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    services.rename_file(owner, project.id, project.entrypoint_file_id, 1, "renamed.py")
    with pytest.raises(services.MetadataConflict):
        services.add_file(owner, project.id, 1, "stale.py")
    services.update_project(owner, project.id, 2, archived=True)
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 3, "blocked.py")
    services.update_project(owner, project.id, 3, archived=False)
    workspaces.update_workspace(owner, workspace.id, archived=True)
    with pytest.raises(ValidationError):
        services.add_file(owner, project.id, 4, "blocked.py")


@pytest.mark.django_db(transaction=True)
def test_concurrent_file_mutations_have_one_metadata_winner() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")

    def add(path: str) -> str:
        close_old_connections()
        try:
            try:
                services.add_file(owner, project.id, 1, path)
                return "ok"
            except services.MetadataConflict:
                return "conflict"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(add, ["one.py", "two.py"]))
    assert sorted(results) == ["conflict", "ok"]
    assert project.files.count() == 2


def test_api_rejects_identity_generation_source_and_runtime_mass_assignment() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    client = signed_in(owner)
    for extra in [
        {"owner_id": str(owner.id)},
        {"runtime_url": "https://untrusted.invalid/"},
    ]:
        assert (
            client.post(
                f"/api/v1/workspaces/{workspace.id}/projects/",
                {"name": "Unsafe", **extra},
                content_type="application/json",
            ).status_code
            == 400
        )
    project = services.create_project(owner, workspace.id, "Project")
    path = f"/api/v1/projects/{project.id}/files/{project.entrypoint_file_id}/"
    changes: list[dict[str, object]] = [
        {"initial_source": "overwrite"},
        {"generation": 2},
        {"project_id": str(project.id)},
    ]
    for change in changes:
        assert (
            client.patch(
                path, {"expected_version": 1, **change}, content_type="application/json"
            ).status_code
            == 400
        )


def test_database_requires_owner_membership_in_same_workspace() -> None:
    owner = person("owner")
    outsider = person("outsider")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    with pytest.raises(IntegrityError), transaction.atomic():
        Project.objects.filter(id=project.id).update(owner=outsider)
        with connection.cursor() as cursor:
            cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


def test_actual_api_responses_match_public_response_contracts() -> None:
    from code_along.common.schemas import (
        CurrentUserOutput,
        FileSource,
        ProjectOutput,
        WorkspaceOutput,
    )

    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    client = signed_in(owner)
    from code_along.common.api import BodySerializer

    cases: list[tuple[type[BodySerializer], str]] = [
        (CurrentUserOutput, "/api/v1/me/"),
        (WorkspaceOutput, f"/api/v1/workspaces/{workspace.id}/"),
        (ProjectOutput, f"/api/v1/projects/{project.id}/"),
        (
            FileSource,
            f"/api/v1/projects/{project.id}/files/{project.entrypoint_file_id}/",
        ),
    ]
    for serializer_type, url in cases:
        response = client.get(url)
        assert response.status_code == 200
        serializer = serializer_type(data=response.json())
        assert serializer.is_valid(), serializer.errors


def test_file_delete_uses_explicit_version_query_precondition() -> None:
    owner = person("owner")
    workspace = workspaces.create_workspace(owner, "Group")
    project = services.create_project(owner, workspace.id, "Project")
    file = services.add_file(owner, project.id, 1, "helper.py")
    client = signed_in(owner)
    path = f"/api/v1/projects/{project.id}/files/{file.id}/"
    assert client.delete(path).status_code == 400
    assert client.delete(path + "?expected_version=1").status_code == 409
    assert client.delete(path + "?expected_version=2").status_code == 204

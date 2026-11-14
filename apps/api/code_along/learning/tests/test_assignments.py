import copy
import io
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch

import pytest
from allauth.account.models import EmailAddress
from django.core.cache import cache
from django.core.management import call_command
from django.db import IntegrityError, close_old_connections, connection, transaction
from django.test import Client
from rest_framework.exceptions import APIException, ParseError

from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.learning import api, contracts, services
from code_along.learning.models import Assignment, AssignmentVersion
from code_along.projects import revision_services
from code_along.projects import services as projects
from code_along.projects.models import Project, ProjectAccess
from code_along.projects.tests.test_history import create_revision, fixture_project
from code_along.workspaces.models import WorkspaceMembership
from code_along.workspaces.tests.test_workspaces import person, signed_in

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]


@pytest.fixture(autouse=True)
def catalog_and_throttles() -> None:
    ensure_runtime_catalog()
    cache.clear()


def write(
    client: Client, path: str, body: dict[str, Any], *, method: str = "post"
) -> Any:
    return getattr(client, method)(
        path, body, content_type="application/json", secure=True
    )


def setup_assignment() -> tuple[Project, Client, Assignment]:
    project, client = fixture_project()
    response = write(
        client,
        f"/api/v1/workspaces/{project.workspace_id}/assignments/",
        {"title": "Exact assignment 🐍"},
    )
    assert response.status_code == 201, response.content
    assignment = Assignment.objects.get(id=response.json()["id"])
    return project, client, assignment


def ready_assignment() -> tuple[Project, Client, Assignment]:
    project, client, assignment = setup_assignment()
    revision = create_revision(project, client)
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": 1,
            "instructions": "Instructions π\r\nKeep exact bytes.\r\n",
            "hints": [
                {
                    "id": str(uuid.uuid4()),
                    "title": "First hint",
                    "body": "Try café and café\r\n",
                }
            ],
            "starter_revision_id": str(revision.id),
            "public_checks_source": 'assert "π" != "🐍"\r\n',
        },
        method="patch",
    )
    assert response.status_code == 200, response.content
    assignment.refresh_from_db()
    return project, client, assignment


def publish(
    client: Client,
    assignment: Assignment,
    *,
    nonce: uuid.UUID | None = None,
    revision: int | None = None,
) -> Any:
    return write(
        client,
        f"/api/v1/assignments/{assignment.id}/versions/",
        {
            "expected_revision": revision or assignment.revision,
            "client_request_id": str(nonce or uuid.uuid4()),
        },
    )


def member(project: Project, name: str, role: str = "learner") -> Client:
    user = person(name)
    WorkspaceMembership.objects.create(
        workspace=project.workspace, user=user, role=role
    )
    return signed_in(user)


def test_published_frozen_content_and_exact_full_metadata_survive_draft_live_and_archive_changes() -> (
    None
):
    project, owner, assignment = ready_assignment()
    learner = member(project, "learner")
    base = f"/api/v1/assignments/{assignment.id}/"
    assert learner.get(base, secure=True).status_code == 404
    published = publish(owner, assignment)
    assert published.status_code == 201, published.content
    version = AssignmentVersion.objects.get()
    detail = published.json()
    assert detail["instructions"] == assignment.draft_instructions
    assert detail["hints"] == assignment.draft_hints
    assert detail["public_checks"]["source"] == assignment.draft_public_checks_source
    assert version.content_sha256 == contracts.content_digest(version)
    assert version.metadata_bytes == contracts.metadata_size(version)
    assignment.refresh_from_db()
    assert assignment.published_metadata_bytes == version.metadata_bytes
    changed = write(
        owner,
        base + "draft/",
        {
            "expected_revision": assignment.revision,
            "title": "Private next draft",
            "instructions": "Never published",
        },
        method="patch",
    )
    assert changed.status_code == 200
    projects.rename_file(
        project.owner, project.id, project.entrypoint_file_id, 1, "private_new_name.py"
    )
    Project.objects.filter(id=project.id).update(archived_at=version.published_at)
    assert learner.get(base, secure=True).json()["title"] == "Exact assignment 🐍"
    assert learner.get(base + "draft/", secure=True).status_code == 403
    assert learner.get(base + f"versions/{version.id}/", secure=True).json() == detail
    starter = learner.get(base + f"versions/{version.id}/starter/", secure=True)
    assert starter.status_code == 200 and starter["Cache-Control"] == "no-store"
    assert starter.json()["manifest"]["files"][0]["path"] == "main.py"
    assert (
        starter.json()["manifest"]["files"][0]["source"]
        == '# frozen live 🐍\r\nprint("revision")\r\n'
    )
    assert not ProjectAccess.objects.filter(project=project).exists()
    assert (
        learner.get(f"/api/v1/projects/{project.id}/", secure=True).status_code == 404
    )


def test_coteacher_reuses_same_assignment_published_h_without_live_queries_but_cannot_disclose_h2() -> (
    None
):
    project, owner, assignment = ready_assignment()
    first = publish(owner, assignment)
    assert first.status_code == 201
    assignment.refresh_from_db()
    first_id = first.json()["starter"]["revision_id"]
    second_private = create_revision(project, owner)
    teacher = member(project, "co-teacher", "instructor")
    base = f"/api/v1/assignments/{assignment.id}/"
    with patch.object(
        Project.objects,
        "select_for_update",
        side_effect=AssertionError("Private live project lookup"),
    ):
        changed = write(
            teacher,
            base + "draft/",
            {
                "expected_revision": assignment.revision,
                "instructions": "Co-teacher corrected instructions\r\n",
                "starter_revision_id": first_id,
            },
            method="patch",
        )
        assert changed.status_code == 200, changed.content
        assert changed.json()["starter_origin"] == {
            "kind": "published_assignment",
            "assignment_version_id": first.json()["id"],
            "number": 1,
        }
        next_version = publish(teacher, assignment, revision=changed.json()["revision"])
        assert next_version.status_code == 201, next_version.content
    assignment.refresh_from_db()
    assert next_version.json()["starter"] == first.json()["starter"]
    assert next_version.json()["runtime"] == first.json()["runtime"]
    assert (
        write(
            teacher,
            base + "draft/",
            {
                "expected_revision": assignment.revision,
                "starter_revision_id": str(second_private.id),
            },
            method="patch",
        ).status_code
        == 404
    )
    assert (
        teacher.get(f"/api/v1/projects/{project.id}/", secure=True).status_code == 404
    )
    assert not ProjectAccess.objects.filter(project=project).exists()


def test_other_assignment_publication_does_not_authorize_first_disclosure() -> None:
    project, owner, assignment = ready_assignment()
    assert publish(owner, assignment).status_code == 201
    teacher = member(project, "other-teacher", "instructor")
    created = write(
        teacher,
        f"/api/v1/workspaces/{project.workspace_id}/assignments/",
        {"title": "Other assignment"},
    )
    other_id = created.json()["id"]
    response = write(
        teacher,
        f"/api/v1/assignments/{other_id}/draft/",
        {
            "expected_revision": 1,
            "starter_revision_id": str(assignment.draft_starter_revision_id),
        },
        method="patch",
    )
    assert response.status_code == 404


@pytest.mark.parametrize("role", ["instructor", "learner"])
def test_source_editor_or_project_owner_without_teaching_never_gets_publication_authority(
    role: str,
) -> None:
    project, owner, assignment = ready_assignment()
    client = member(project, "editor", role)
    user = WorkspaceMembership.objects.get(
        workspace=project.workspace, user__email="editor@example.test"
    ).user
    projects.set_grant(project.owner, project.id, user.id, "editor")
    response = write(
        client,
        f"/api/v1/assignments/{assignment.id}/draft/",
        {
            "expected_revision": assignment.revision,
            "starter_revision_id": str(assignment.draft_starter_revision_id),
        },
        method="patch",
    )
    assert response.status_code == 403
    if role == "learner":
        Project.objects.filter(id=project.id).update(owner=user)
        assert publish(client, assignment).status_code == 403


def test_published_read_and_original_nonce_never_bypass_current_workspace_session_or_verification() -> (
    None
):
    project, owner, assignment = ready_assignment()
    nonce = uuid.uuid4()
    original = publish(owner, assignment, nonce=nonce)
    assert original.status_code == 201
    assert publish(owner, assignment, nonce=nonce).status_code == 200
    assert (
        publish(
            owner, assignment, nonce=nonce, revision=assignment.revision + 1
        ).status_code
        == 409
    )
    base = f"/api/v1/assignments/{assignment.id}/"
    outsider = signed_in(person("outsider"))
    assert outsider.get(base, secure=True).status_code == 404
    assert (
        outsider.get(
            base + f"versions/{original.json()['id']}/starter/", secure=True
        ).status_code
        == 404
    )
    EmailAddress.objects.filter(user=project.owner).update(verified=False)
    assert owner.get(base, secure=True).status_code == 403
    assert publish(owner, assignment, nonce=nonce).status_code == 403


@pytest.mark.parametrize(
    "race", ["password", "logout", "role", "membership", "ownership", "runtime"]
)
def test_final_publication_rechecks_actual_session_authority_source_and_runtime(
    race: str,
) -> None:
    project, client, assignment = ready_assignment()
    original = revision_services.revision_manifest

    def mutate(starter: Any) -> Any:
        result = original(starter)
        if race == "password":
            project.owner.set_password("different-copper-river-orbit-84!")
            project.owner.save(update_fields=["password"])
        elif race == "logout":
            client.logout()
        elif race in {"role", "membership"}:
            changes: dict[str, Any] = (
                {"role": "learner"} if race == "role" else {"active": False}
            )
            WorkspaceMembership.objects.filter(
                workspace=project.workspace, user=project.owner
            ).update(**changes)
        elif race == "ownership":
            other = person("new-owner")
            Project.objects.filter(id=project.id).update(owner=other)
        else:
            starter.runtime_profile.enabled = False
            starter.runtime_profile.save(update_fields=["enabled"])
        return result

    with patch.object(services, "revision_manifest", side_effect=mutate):
        response = publish(client, assignment)
    assert response.status_code in {400, 403, 404}, response.content
    assert not AssignmentVersion.objects.exists()
    assignment.refresh_from_db()
    assert (
        assignment.current_version_id is None
        and assignment.published_metadata_bytes == 0
    )


def test_strict_body_bound_and_csrf_origin_are_enforced_before_authoring() -> None:
    project, client, assignment = ready_assignment()
    base = f"/api/v1/assignments/{assignment.id}/draft/"
    oversized = (
        b'{"expected_revision":2,"instructions":"'
        + b"x" * contracts.MAX_REQUEST_BYTES
        + b'"}'
    )
    assert (
        client.patch(
            base, oversized, content_type="application/json", secure=True
        ).status_code
        == 400
    )
    bounded = api.AssignmentJSONParser()
    with pytest.raises(ParseError):
        bounded.parse(io.BytesIO(oversized))
    deep = b'{"title":' + b"[" * 2000 + b"0" + b"]" * 2000 + b"}"
    deep_response = client.post(
        f"/api/v1/workspaces/{project.workspace_id}/assignments/",
        deep,
        content_type="application/json",
        secure=True,
    )
    assert deep_response.status_code == 400 and len(deep_response.content) < 1024
    real = Client(enforce_csrf_checks=True)
    real.force_login(project.owner)
    assert (
        write(
            real,
            f"/api/v1/workspaces/{project.workspace_id}/assignments/",
            {"title": "CSRF"},
        ).status_code
        == 403
    )
    token = real.get("/api/v1/csrf/", secure=True).json()["csrfToken"]
    assert (
        real.post(
            f"/api/v1/workspaces/{project.workspace_id}/assignments/",
            {"title": "CSRF"},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN="https://foreign.example",
        ).status_code
        == 403
    )
    assert (
        real.post(
            f"/api/v1/workspaces/{project.workspace_id}/assignments/",
            {"title": "CSRF"},
            content_type="application/json",
            secure=True,
            HTTP_X_CSRFTOKEN=token,
            HTTP_ORIGIN="https://testserver",
        ).status_code
        == 201
    )


def test_versions_are_immutable_and_every_parent_pair_is_database_enforced() -> None:
    project, client, assignment = ready_assignment()
    assert publish(client, assignment).status_code == 201
    version = AssignmentVersion.objects.get()
    for sql in (
        "UPDATE public.learning_assignmentversion SET title='tampered' WHERE id=%s",
        "DELETE FROM public.learning_assignmentversion WHERE id=%s",
    ):
        with (
            pytest.raises(IntegrityError),
            transaction.atomic(),
            connection.cursor() as cursor,
        ):
            cursor.execute(sql, [version.id])
    other_project, other_client, other_assignment = ready_assignment_unique()
    for fields in (
        {"workspace_id": other_project.workspace_id},
        {"draft_starter_project_id": other_project.id},
        {"draft_starter_revision_id": other_assignment.draft_starter_revision_id},
        {"current_version_id": version.id},
    ):
        target = other_assignment if "current_version_id" in fields else assignment
        with pytest.raises(IntegrityError), transaction.atomic():
            Assignment.objects.filter(id=target.id).update(**fields)
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")
    # A new row can never borrow another assignment/workspace/project's parents.
    for field, value in (
        ("workspace_id", other_project.workspace_id),
        ("starter_project_id", other_project.id),
        ("assignment_id", other_assignment.id),
    ):
        bad = copy.copy(version)
        bad.pk, bad.client_request_id, bad.number = uuid.uuid4(), uuid.uuid4(), 2
        setattr(bad, field, value)
        with pytest.raises(IntegrityError), transaction.atomic():
            bad.save(force_insert=True)
            with connection.cursor() as cursor:
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


@pytest.mark.parametrize("stage", ["runtime_lock", "metadata"])
def test_logout_during_final_wait_or_metadata_preparation_cannot_publish(
    stage: str,
) -> None:
    _, client, assignment = ready_assignment()
    original = (
        contracts.metadata_size if stage == "metadata" else services.verify_runtime
    )
    calls = 0

    def expire(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        result = original(*args, **kwargs)
        if stage == "metadata" or calls == 2:
            client.logout()
        return result

    target, name = (
        (contracts, "metadata_size")
        if stage == "metadata"
        else (services, "verify_runtime")
    )
    with patch.object(target, name, side_effect=expire):
        response = publish(client, assignment)
    assert response.status_code == 403
    assignment.refresh_from_db()
    assert not AssignmentVersion.objects.exists()
    assert (
        assignment.current_version_id is None
        and assignment.published_metadata_bytes == 0
    )


def test_committed_retry_after_archive_is_read_only_and_still_requires_current_teacher() -> (
    None
):
    project, client, assignment = ready_assignment()
    nonce, original_revision = uuid.uuid4(), assignment.revision
    first = publish(client, assignment, nonce=nonce)
    assignment.refresh_from_db()
    archived = write(
        client,
        f"/api/v1/assignments/{assignment.id}/",
        {"expected_revision": assignment.revision, "archived": True},
        method="patch",
    )
    assert archived.status_code == 200
    assert (
        publish(client, assignment, nonce=nonce, revision=original_revision).json()
        == first.json()
    )
    assert publish(client, assignment).status_code == 400
    WorkspaceMembership.objects.filter(
        workspace=project.workspace, user=project.owner
    ).update(role="learner")
    assert (
        publish(client, assignment, nonce=nonce, revision=original_revision).status_code
        == 403
    )
    assert AssignmentVersion.objects.count() == 1


def ready_assignment_unique() -> tuple[Project, Client, Assignment]:
    user = person("other-source")
    from code_along.workspaces.services import create_workspace

    project = projects.create_project(user, create_workspace(user, "Other").id, "Other")
    client = signed_in(user)
    assignment = services.create_assignment(
        user, client.session.session_key, project.workspace_id, title="Other"
    )
    revision = create_revision(project, client)
    assignment = services.update_draft(
        user,
        client.session.session_key,
        assignment.id,
        expected_revision=1,
        instructions="Other instructions",
        starter_revision_id=revision.id,
    )
    return project, client, assignment


def test_valid_lowered_capacity_boundaries_metadata_sum_and_original_retry_are_atomic() -> (
    None
):
    _, client, assignment = ready_assignment()
    nonce = uuid.uuid4()
    first = publish(client, assignment, nonce=nonce)
    assert first.status_code == 201
    first_version = AssignmentVersion.objects.get()
    assignment.refresh_from_db()
    assert assignment.published_metadata_bytes == contracts.metadata_size(first_version)
    with patch.object(contracts, "MAX_VERSIONS", 1):
        assert (
            publish(
                client, assignment, nonce=nonce, revision=first_version.source_revision
            ).status_code
            == 200
        )
        capacity = publish(client, assignment)
        assert (
            capacity.status_code == 409
            and capacity.json()["code"] == "assignment_version_capacity"
        )
        assert "Retry-After" not in capacity
    with patch.object(
        contracts, "MAX_VERSION_METADATA", first_version.metadata_bytes - 1
    ):
        assert (
            publish(client, assignment).json()["code"]
            == "assignment_version_metadata_limit"
        )
    with patch.object(
        contracts, "MAX_ASSIGNMENT_METADATA", assignment.published_metadata_bytes
    ):
        assert (
            publish(client, assignment).json()["code"] == "assignment_metadata_capacity"
        )
    assignment.refresh_from_db()
    assert (
        assignment.published_metadata_bytes == first_version.metadata_bytes
        and assignment.versions.count() == 1
    )
    assert (
        contracts.MAX_ASSIGNMENTS,
        contracts.MAX_VERSIONS,
        contracts.MAX_VERSION_METADATA,
        contracts.MAX_ASSIGNMENT_METADATA,
    ) == (100, 50, 262144, 4194304)


def test_fault_after_immutable_insert_rolls_back_counter_pointer_revision_and_row() -> (
    None
):
    _, client, assignment = ready_assignment()
    before = assignment.revision
    original = Assignment.save

    def fail(instance: Assignment, *args: Any, **kwargs: Any) -> None:
        if instance.current_version_id is not None:
            raise IntegrityError("Owned publication fault")
        original(instance, *args, **kwargs)

    with patch.object(Assignment, "save", fail), pytest.raises(IntegrityError):
        publish(client, assignment)
    assignment.refresh_from_db()
    assert assignment.revision == before and assignment.current_version_id is None
    assert (
        assignment.published_metadata_bytes == 0
        and not AssignmentVersion.objects.exists()
    )


@pytest.mark.django_db(transaction=True)
def test_workspace_capacity_and_publish_cas_serialize_concurrent_real_transactions() -> (
    None
):
    project, client, assignment = ready_assignment()
    owner, key = project.owner, client.session.session_key

    def create_one(index: int) -> int:
        close_old_connections()
        try:
            services.create_assignment(
                owner, key, project.workspace_id, title=f"Concurrent {index}"
            )
            return 201
        except APIException as error:
            return error.status_code
        finally:
            close_old_connections()

    with (
        patch.object(contracts, "MAX_ASSIGNMENTS", 2),
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        assert sorted(executor.map(create_one, [1, 2])) == [201, 409]
    assert Assignment.objects.filter(workspace=project.workspace).count() == 2

    def publish_one(_: int) -> int:
        close_old_connections()
        try:
            services.publish_version(
                owner,
                key,
                assignment.id,
                expected_revision=assignment.revision,
                client_request_id=uuid.uuid4(),
            )
            return 201
        except APIException as error:
            return error.status_code
        finally:
            close_old_connections()

    with (
        patch.object(contracts, "MAX_VERSIONS", 1),
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        assert sorted(executor.map(publish_one, [1, 2])) == [201, 409]
    assignment.refresh_from_db()
    assert assignment.versions.count() == 1
    assert assignment.published_metadata_bytes == sum(
        v.metadata_bytes for v in assignment.versions.all()
    )


@pytest.mark.django_db(transaction=True)
def test_learning_migrations_reverse_and_restore_all_leaf_guards_without_drift() -> (
    None
):
    call_command("migrate", "learning", "zero", verbosity=0)
    call_command("migrate", verbosity=0)
    call_command("makemigrations", "--check", "--dry-run", stdout=io.StringIO())
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT count(*) FROM pg_trigger WHERE tgname='immutable_assignment_version' AND NOT tgisinternal"
        )
        assert cursor.fetchone() == (1,)

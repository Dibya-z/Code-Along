import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from allauth.account.models import EmailAddress
from code_along.accounts.models import User
from code_along.workspaces import services
from code_along.workspaces.models import Workspace
from code_along.workspaces.models import WorkspaceMembership as Membership
from django.db import IntegrityError, close_old_connections, transaction
from django.test import Client
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]
BASE = "/api/v1/workspaces/"


def person(name: str) -> User:
    user = User.objects.create_user(
        email=f"{name}@example.test",
        display_name=name,
        password="river-orbit-copper-84!",
    )
    EmailAddress.objects.create(
        user=user, email=user.email, verified=True, primary=True
    )
    return user


def signed_in(user: User) -> Client:
    client = Client()
    client.force_login(user)
    return client


def test_create_is_atomic_and_assigns_one_owner(client: Client) -> None:
    user = person("owner")
    client.force_login(user)
    response = client.post(
        BASE, {"name": " Python circle "}, content_type="application/json"
    )
    assert response.status_code == 201
    workspace = Workspace.objects.get()
    assert workspace.name == "Python circle" and workspace.created_by == user
    assert (
        Membership.objects.filter(
            workspace=workspace, active=True, role="owner", user=user
        ).count()
        == 1
    )
    assert client.get(BASE).json()["count"] == 1
    assert response.json()["acl_version"] == "1"


@pytest.mark.parametrize(
    "body",
    [
        {"name": " "},
        {"name": "x" * 101},
        {"name": "Good", "created_by": "other"},
        {"name": "Good", "role": "owner"},
    ],
)
def test_create_rejects_invalid_names_and_mass_assignment(
    body: dict[str, object],
) -> None:
    assert (
        signed_in(person("owner"))
        .post(BASE, body, content_type="application/json")
        .status_code
        == 400
    )
    assert Workspace.objects.count() == 0


def test_anonymous_and_unverified_cannot_create(client: Client) -> None:
    assert client.post(BASE, {"name": "A"}).status_code == 403
    user = person("pending")
    EmailAddress.objects.filter(user=user).update(verified=False)
    client.force_login(user)
    assert (
        client.post(BASE, {"name": "A"}, content_type="application/json").status_code
        == 403
    )


@pytest.mark.parametrize("role", ["instructor", "learner"])
def test_non_owner_members_have_no_administration_privilege(role: str) -> None:
    owner = person("owner")
    member = person("member")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=member, role=role)
    client = signed_in(member)
    url = f"{BASE}{workspace.id}/"
    assert client.get(url).status_code == 200
    assert (
        client.patch(
            url, {"name": "Changed"}, content_type="application/json"
        ).status_code
        == 403
    )
    assert (
        client.post(
            url + "ownership/",
            {"new_owner_id": str(member.id)},
            content_type="application/json",
        ).status_code
        == 403
    )
    assert (
        client.patch(
            url + f"members/{owner.id}/",
            {"role": "learner"},
            content_type="application/json",
        ).status_code
        == 403
    )


def test_cross_workspace_ids_and_removed_members_are_unavailable() -> None:
    owner = person("owner")
    stranger = person("stranger")
    workspace = services.create_workspace(owner, "Private group")
    client = signed_in(stranger)
    url = f"{BASE}{workspace.id}/"
    assert client.get(BASE).json()["count"] == 0
    assert client.get(url).status_code == 404
    assert client.get(url + "members/").status_code == 404
    assert (
        client.patch(url, {"name": "No"}, content_type="application/json").status_code
        == 404
    )
    member = Membership.objects.create(
        workspace=workspace, user=stranger, role="learner"
    )
    assert client.get(url).status_code == 200
    services.update_member(owner, workspace.id, stranger.id, remove=True)
    member.refresh_from_db()
    assert not member.active
    assert client.get(url).status_code == 404


def test_transfer_and_last_owner_guard() -> None:
    owner = person("owner")
    target = person("target")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=target, role="learner")
    with pytest.raises(ValidationError):
        services.update_member(owner, workspace.id, owner.id, remove=True)
    services.transfer_ownership(owner, workspace.id, target.id)
    assert (
        Membership.objects.filter(workspace=workspace, active=True, role="owner")
        .get()
        .user
        == target
    )
    assert Membership.objects.get(workspace=workspace, user=owner).role == "instructor"
    with pytest.raises(PermissionDenied):
        services.update_workspace(owner, workspace.id, name="No")
    with pytest.raises(ValidationError):
        services.transfer_ownership(target, workspace.id, uuid.uuid4())


def test_members_can_leave_but_cannot_remove_someone_else() -> None:
    owner = person("owner")
    member = person("member")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    with pytest.raises(PermissionDenied):
        services.update_member(member, workspace.id, owner.id, remove=True)
    services.update_member(member, workspace.id, member.id, remove=True)
    with pytest.raises(NotFound):
        services.update_member(member, workspace.id, member.id, remove=True)


def test_archiving_preserves_records_and_blocks_membership_changes() -> None:
    owner = person("owner")
    member = person("member")
    workspace = services.create_workspace(owner, "Group")
    Membership.objects.create(workspace=workspace, user=member, role="learner")
    services.update_workspace(owner, workspace.id, archived=True)
    with pytest.raises(ValidationError):
        services.update_member(owner, workspace.id, member.id, role="instructor")
    assert signed_in(member).get(f"{BASE}{workspace.id}/").status_code == 200
    services.update_workspace(owner, workspace.id, archived=False)
    services.update_member(owner, workspace.id, member.id, role="instructor")
    assert Workspace.objects.count() == 1


def test_database_rejects_duplicate_members_and_owners() -> None:
    owner = person("owner")
    other = person("other")
    workspace = services.create_workspace(owner, "Group")
    with pytest.raises(IntegrityError), transaction.atomic():
        Membership.objects.create(workspace=workspace, user=other, role="owner")
    with pytest.raises(IntegrityError), transaction.atomic():
        Membership.objects.create(workspace=workspace, user=owner, role="learner")


@pytest.mark.django_db(transaction=True)
def test_concurrent_transfers_cannot_leave_two_or_zero_owners() -> None:
    owner = person("owner")
    one = person("one")
    two = person("two")
    workspace = services.create_workspace(owner, "Group")
    for user in [one, two]:
        Membership.objects.create(workspace=workspace, user=user, role="learner")

    def transfer(target: User) -> str:
        close_old_connections()
        try:
            services.transfer_ownership(owner, workspace.id, target.id)
            return "ok"
        except PermissionDenied:
            return "denied"
        finally:
            close_old_connections()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(transfer, [one, two]))
    assert sorted(results) == ["denied", "ok"]
    assert (
        Membership.objects.filter(
            workspace=workspace, role="owner", active=True
        ).count()
        == 1
    )


def test_pagination_is_bounded_and_roster_does_not_expose_emails() -> None:
    owner = person("owner")
    workspace = services.create_workspace(owner, "Group")
    client = signed_in(owner)
    assert client.get(BASE + "?limit=101").status_code == 400
    assert client.get(BASE + "?offset=-1").status_code == 400
    assert client.get(BASE + "?limit=1").json()["count"] == 1
    item = client.get(f"{BASE}{workspace.id}/members/").json()["items"][0]
    assert item == {"user_id": str(owner.id), "display_name": "owner", "role": "owner"}

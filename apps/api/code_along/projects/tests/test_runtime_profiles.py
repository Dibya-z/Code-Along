import hashlib
import json
from pathlib import Path

import pytest
from code_along.projects import services
from code_along.projects.models import RuntimeProfile
from code_along.projects.runtime_catalog import PROFILE_ID, SCIENTIFIC_PROFILE_ID
from code_along.workspaces import services as workspaces
from code_along.workspaces.tests.test_workspaces import person, signed_in
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from rest_framework.exceptions import ValidationError

pytestmark = [pytest.mark.postgres, pytest.mark.django_db]
ROOT = Path(__file__).resolve().parents[5]


def test_scientific_catalogue_matches_frozen_inventory_and_is_session_protected() -> (
    None
):
    inventory = json.loads(
        (
            ROOT / "packages/runtime-profiles/manifests/pyodide-scientific.json"
        ).read_text()
    )
    profile = RuntimeProfile.objects.get(id=SCIENTIFIC_PROFILE_ID)
    digest = hashlib.sha256(
        json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert profile.manifest == inventory and profile.manifest_sha256 == digest
    owner = person("runtime-owner")
    client = signed_in(owner)
    response = client.get("/api/v1/runtime-profiles/")
    assert response.status_code == 200
    values = {entry["id"]: entry for entry in response.json()["items"]}
    assert set(values) == {str(PROFILE_ID), str(SCIENTIFIC_PROFILE_ID)}
    assert values[str(SCIENTIFIC_PROFILE_ID)]["manifest_sha256"] == digest
    assert "no-store" in response["Cache-Control"]
    client.logout()
    assert client.get("/api/v1/runtime-profiles/").status_code == 403


def test_scientific_project_default_is_explicit_and_disabled_profiles_are_denied() -> (
    None
):
    owner = person("scientific-owner")
    workspace = workspaces.create_workspace(owner, "Study")
    project = services.create_project(
        owner, workspace.id, "Arrays", SCIENTIFIC_PROFILE_ID
    )
    assert project.runtime_profile_id == SCIENTIFIC_PROFILE_ID
    RuntimeProfile.objects.filter(id=SCIENTIFIC_PROFILE_ID).update(enabled=False)
    with pytest.raises(ValidationError, match="enabled runtime"):
        services.create_project(owner, workspace.id, "Disabled", SCIENTIFIC_PROFILE_ID)


@pytest.mark.django_db(transaction=True)
def test_scientific_data_migration_reverses_and_reapplies_on_owned_empty_profile_scope() -> (
    None
):
    previous = ("projects", "0002_parent_constraints_and_runtime")
    target = ("projects", "0003_scientific_runtime")
    try:
        MigrationExecutor(connection).migrate([previous])
        assert not RuntimeProfile.objects.filter(id=SCIENTIFIC_PROFILE_ID).exists()
        assert RuntimeProfile.objects.filter(id=PROFILE_ID).exists()
    finally:
        MigrationExecutor(connection).migrate([target])
    assert (
        RuntimeProfile.objects.get(id=SCIENTIFIC_PROFILE_ID).manifest_sha256
        == "eb2bfd5f172ccce38411575452b4c723f939a14e095a94a612fb1f9d5fdf21ea"
    )

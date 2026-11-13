import hashlib
import json
from pathlib import Path

import pytest
from code_along.projects.models import RuntimeProfile
from code_along.projects.runtime_catalog import PROFILE_ID


@pytest.fixture(autouse=True)
def runtime_catalog(db: None) -> None:
    # Transactional tests flush data-migration rows; restore only this owned test DB.
    profile = json.loads(
        (
            Path(__file__).resolve().parents[5]
            / "apps/runner-web/public/runtime-manifests/pyodide-core.json"
        ).read_text()
    )
    RuntimeProfile.objects.get_or_create(
        id=PROFILE_ID,
        defaults={
            "runtime_id": profile["runtime_id"],
            "manifest": profile,
            "manifest_sha256": hashlib.sha256(
                json.dumps(profile, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        },
    )

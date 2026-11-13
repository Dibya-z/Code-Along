import hashlib
import json
from pathlib import Path

from code_along.projects.models import RuntimeProfile
from code_along.projects.runtime_catalog import PROFILE_ID


def ensure_runtime_catalog() -> None:
    # Transactional cases flush migration data. Restore only the reviewed owned fixture.
    root = Path(__file__).resolve().parents[5]
    profile = json.loads(
        (
            root / "apps/runner-web/public/runtime-manifests/pyodide-core.json"
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

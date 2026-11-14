import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]


def test_offline_generation_matches_committed_contracts_without_database() -> None:
    result = subprocess.run(
        [sys.executable, "tools/dev/generate_api_schema.py", "--check"],
        cwd=ROOT,
        env={**os.environ, "DJANGO_SETTINGS_MODULE": "config.settings.production"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "without connecting to services" in result.stdout


def test_schema_requires_authentication_and_metadata_preconditions() -> None:
    schema = json.loads((ROOT / "docs/api/openapi.json").read_text())
    assert schema["openapi"] == "3.1.0"
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            if method not in {"get", "post", "put", "patch", "delete"}:
                continue
            if path == "/api/v1/shares/resolve/":
                # Unbound snapshot capabilities can resolve anonymously.
                assert operation["security"] == [{"cookieAuth": []}, {}]
            elif path != "/api/v1/csrf/":
                assert operation["security"] == [{"cookieAuth": []}]
    for name in [
        "ProjectBodyRequest",
        "RenameBodyRequest",
        "FileBodyRequest",
        "ProjectTransferBodyRequest",
    ]:
        assert "expected_version" in schema["components"]["schemas"][name]["required"]
    delete = schema["paths"]["/api/v1/projects/{project_id}/files/{file_id}/"]["delete"]
    assert any(
        p["name"] == "expected_version" and p["required"] and p["in"] == "query"
        for p in delete["parameters"]
    )


def test_auth_schema_has_only_browser_clients_and_custom_signup_profile() -> None:
    schema = json.loads((ROOT / "docs/api/auth-openapi.json").read_text())
    assert schema["paths"] and all("/browser/" in path for path in schema["paths"])
    signup = schema["components"]["schemas"]["BaseSignup"]
    assert (
        "display_name" in signup["properties"] and "display_name" in signup["required"]
    )

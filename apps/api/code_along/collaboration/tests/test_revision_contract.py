import copy
import io
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.test import override_settings

from code_along.collaboration.control import (
    ControlUnavailable,
    NoRedirect,
    post_control,
)
from code_along.projects.revision_api import CreateRevisionBody
from code_along.projects.revision_contract import (
    HELPER_RELEASE,
    RevisionContractError,
    revision_hash,
    source_digest,
    validate_manifest,
)


def golden_manifest() -> dict[str, Any]:
    return {
        "protocol": "code-along.revision",
        "version": 1,
        "project_id": "10000000-0000-4000-8000-000000000001",
        "metadata_version": 7,
        "entrypoint_file_id": "10000000-0000-4000-8000-000000000002",
        "runtime": {
            "runtime_id": "pyodide-314.0.7-core",
            "manifest_sha256": "4eb12f345e0f14f57c93603c8d8a2d3d62c69e2e82618c63cac87dc0aafadf40",
            "engine": "pyodide",
            "engine_version": "314.0.7",
            "python_version": "3.14.2",
        },
        "helper_release": dict(HELPER_RELEASE),
        "files": [
            {
                "file_id": "10000000-0000-4000-8000-000000000002",
                "document_id": "10000000-0000-4000-8000-000000000003",
                "generation": 1,
                "path": "main.py",
                "source": 'print("π 🐍")\r\n# quote=" slash=\\ tab=\t ctrl=\u0001 sep=\u2028\u2029\n',
                "sha256": "f4a2dc099c1c32042362d3005144f19606c6e684ebffc4da37f6c3e2a0090304",
            },
            {
                "file_id": "10000000-0000-4000-8000-000000000004",
                "document_id": "10000000-0000-4000-8000-000000000005",
                "generation": 7,
                "path": "pkg/helper.py",
                "source": '# café e\u0301\nvalue = "\\\\path"\n',
                "sha256": "fdcf236aeb9c492234a330cb6cafb636818f17603d377b62b76f0df549ac1a12",
            },
        ],
        "sha256": "1077932e6691b1bdba48761ea561850b54c148993917bfe705a8cd0ced437721",
    }


def test_node_python_golden_manifest_preserves_unicode_crlf_controls_and_helper_identity() -> (
    None
):
    value = golden_manifest()
    for file in value["files"]:
        assert source_digest(file["source"])[1] == file["sha256"]
    assert revision_hash(value) == value["sha256"]
    accepted = validate_manifest(value)
    assert accepted == value
    value["files"][0]["source"] = "changed"
    assert accepted["files"][0]["source"].startswith('print("π 🐍")\r\n')


@pytest.mark.parametrize("version", [True, "1", 0])
def test_named_revision_expected_version_is_a_strict_positive_json_integer(
    version: Any,
) -> None:
    serializer = CreateRevisionBody(
        data={
            "name": "A moment",
            "expected_version": version,
            "client_request_id": "10000000-0000-4000-8000-000000000001",
        }
    )
    assert not serializer.is_valid()


@pytest.mark.parametrize(
    "mutation",
    [
        "version",
        "counter",
        "helper",
        "digest",
        "extra",
        "order",
        "identity",
        "traversal",
        "nul",
        "surrogate",
        "size",
    ],
)
def test_manifest_rejects_malformed_or_tampered_complete_source(mutation: str) -> None:
    value = copy.deepcopy(golden_manifest())
    if mutation == "version":
        value["version"] = True
    elif mutation == "counter":
        value["metadata_version"] = "7"
    elif mutation == "helper":
        value["helper_release"]["source_sha256"] = "0" * 64
    elif mutation == "digest":
        value["files"][0]["sha256"] = "0" * 64
    elif mutation == "extra":
        value["authorization"] = "forbidden"
    elif mutation == "order":
        value["files"].reverse()
    elif mutation == "identity":
        value["files"][1]["document_id"] = value["files"][0]["document_id"]
    elif mutation == "traversal":
        value["files"][0]["path"] = "../main.py"
    elif mutation == "nul":
        value["files"][0]["source"] = "\0"
    elif mutation == "surrogate":
        value["files"][0]["source"] = "\ud800"
    else:
        value["files"][0]["source"] = "a" * (131072 + 1)
    with pytest.raises(RevisionContractError, match="^invalid_revision_manifest$"):
        validate_manifest(value)


class Response(io.BytesIO):
    status = 200


def test_private_control_reads_bounded_json_without_env_proxies_or_redirects() -> None:
    opener = MagicMock()
    opener.open.return_value = Response(b'{"version":1}')
    with (
        override_settings(
            COLLABORATION_CONTROL_URL="http://collaboration:1234",
            COLLABORATION_CONTROL_SECRET="private-test-" + "s" * 43,
        ),
        patch(
            "code_along.collaboration.control.build_opener", return_value=opener
        ) as builder,
    ):
        assert post_control(
            "/internal/v1/captures/", {"version": 1}, maximum=128, timeout=1
        ) == {"version": 1}
    request = opener.open.call_args.args[0]
    assert request.full_url == "http://collaboration:1234/internal/v1/captures/"
    assert builder.call_args.args[0].proxies == {}
    assert (
        NoRedirect().redirect_request(
            None, None, 302, "", None, "https://elsewhere.test"
        )
        is None
    )


@pytest.mark.parametrize("raw", [b"x" * 129, b"\xff", b"[]", b"{broken"])
def test_private_control_rejects_oversize_invalid_encoding_and_nonobject_responses(
    raw: bytes,
) -> None:
    opener = MagicMock()
    opener.open.return_value = Response(raw)
    with (
        override_settings(
            COLLABORATION_CONTROL_URL="http://collaboration:1234",
            COLLABORATION_CONTROL_SECRET="s" * 43,
        ),
        patch("code_along.collaboration.control.build_opener", return_value=opener),
        pytest.raises(ControlUnavailable),
    ):
        post_control("/internal/v1/captures/", {}, maximum=128, timeout=1)

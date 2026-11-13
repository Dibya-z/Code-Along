"""Loopback-only development image check; does not create real accounts or send mail."""

import hashlib
import json
import re
import ssl
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
APP = "https://127.0.0.1:8443"
RUNNER = "https://localhost:8443"


def main() -> None:
    context = (
        ssl._create_unverified_context()
    )  # Only the fixed loopback self-signed fixture.

    def fetch(
        url: str, headers: dict[str, str] | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        try:
            response = urlopen(
                Request(url, headers=headers or {}), context=context, timeout=3
            )
        except HTTPError as error:
            response = error
        with response:
            return (
                response.status,
                {k.lower(): v for k, v in response.headers.items()},
                response.read(16 * 1024 * 1024),
            )

    deadline = time.monotonic() + 180
    while True:
        try:
            if fetch(APP + "/health/ready/")[0] == 200:
                break
        except (URLError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError("Owned Compose readiness failed")
        time.sleep(2)
    status, headers, body = fetch(APP + "/")
    assert (
        status == 200 and b"<title>Code Along</title>" in body and b'id="root"' in body
    )
    assert headers["cross-origin-opener-policy"] == "same-origin"
    assert headers["cross-origin-embedder-policy"] == "require-corp"
    assert RUNNER in headers["content-security-policy"]
    assert fetch(APP + "/", {"Host": "attacker.invalid"})[0] == 421
    assert fetch(APP + "/api/v1/me/")[0] == 403
    status, headers, body = fetch(APP + "/api/v1/csrf/")
    assert status == 200 and len(json.loads(body)["csrfToken"]) == 64
    assert "domain=" not in headers["set-cookie"].lower()
    assert headers["cache-control"] == "no-store"
    assert fetch(RUNNER + "/api/v1/me/")[0] == 404
    _, _, shell = fetch(RUNNER + "/")
    script = re.search(rb'src="(/assets/[^" ]+\.js)"', shell)
    assert script
    _, _, bootstrap = fetch(RUNNER + script[1].decode())
    worker = re.search(rb"/assets/worker-[A-Za-z0-9_-]+\.js", bootstrap)
    assert worker
    status, headers, _ = fetch(RUNNER + worker[0].decode())
    assert status == 200 and "'wasm-unsafe-eval'" in headers["content-security-policy"]
    assert "worker-src 'none'" in headers["content-security-policy"]
    inventory = json.loads(
        (
            ROOT / "apps/runner-web/public/runtime-manifests/pyodide-core.json"
        ).read_text()
    )
    wasm = next(
        asset for asset in inventory["assets"] if asset["name"] == "pyodide.asm.wasm"
    )
    status, headers, body = fetch(RUNNER + "/runtime/pyodide.asm.wasm")
    assert status == 200 and headers["content-type"] == "application/wasm"
    assert hashlib.sha256(body).hexdigest() == wasm["sha256"]
    print(
        "Compose readiness, React assets, cookie scope, runner routing/CSP and runtime hash passed."
    )


if __name__ == "__main__":
    main()

"""Loopback-only HTTPS proxy/static host matching the development Compose topology."""

import hashlib
import http.client
import http.server
import json
import mimetypes
import os
import ssl
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

from https_server import ThreadedHTTPSServer
from websocket_proxy import proxy_websocket

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("CODE_ALONG_HTTPS_PORT", "8443"))
APP = f"https://127.0.0.1:{PORT}"
RUNNER = f"https://localhost:{PORT}"
RUNTIME_INVENTORIES = {
    "pyodide-core.json": ROOT
    / "apps/runner-web/public/runtime-manifests/pyodide-core.json",
    "pyodide-scientific.json": ROOT
    / "packages/runtime-profiles/manifests/pyodide-scientific.json",
}


class Handler(http.server.BaseHTTPRequestHandler):
    # Every response is length-framed. Keep TLS connections alive while the
    # browser reads large runtime assets instead of making EOF the boundary.
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args: object) -> None:
        pass  # No request paths, tokens or source payloads in routine dev logs.

    def do_GET(self) -> None:
        self.handle_request()

    def do_POST(self) -> None:
        self.handle_request()

    def do_PUT(self) -> None:
        self.handle_request()

    def do_PATCH(self) -> None:
        self.handle_request()

    def do_DELETE(self) -> None:
        self.handle_request()

    def handle_request(self) -> None:
        host = self.headers.get("Host")
        runner = host == f"localhost:{PORT}"
        if host not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}:
            self.send_error(421)
            return
        path = urlsplit(self.path).path
        if path.startswith("/internal/"):
            self.send_error(404)
            return
        if path == "/collab" or path.startswith("/events/"):
            if runner or self.path != path:
                self.send_error(404)
                return
            proxy_websocket(
                self,
                int(os.environ.get("CODE_ALONG_NATIVE_COLLABORATION_PORT", "18002"))
                if path == "/collab"
                else int(os.environ.get("CODE_ALONG_NATIVE_API_PORT", "18000")),
                APP,
            )
            return
        if not runner and path.startswith(("/api/", "/health/")):
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if length < 0 or self.headers.get("Transfer-Encoding"):
                self.send_error(400)
                return
            if length > 2 * 1024 * 1024:
                self.send_error(413)
                return
            request_headers = {
                k: v
                for k, v in self.headers.items()
                if k.lower()
                not in {
                    "connection",
                    "transfer-encoding",
                    "x-forwarded-for",
                    "x-forwarded-proto",
                    "x-forwarded-host",
                }
            }
            request_headers["X-Forwarded-Proto"] = "https"
            request_headers["X-Forwarded-For"] = self.client_address[0]
            with closing(
                http.client.HTTPConnection(
                    "127.0.0.1",
                    int(os.environ.get("CODE_ALONG_NATIVE_API_PORT", "18000")),
                    timeout=10,
                )
            ) as connection:
                connection.request(
                    self.command,
                    self.path,
                    body=self.rfile.read(length),
                    headers=request_headers,
                )
                response = connection.getresponse()
                body = response.read()
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in {
                        "connection",
                        "transfer-encoding",
                        "content-length",
                        "server",
                        "date",
                    }:
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        if self.command != "GET" or runner and path.startswith("/api/"):
            self.send_error(404)
            return
        worker = runner and path.startswith("/assets/worker-")
        base = ROOT / ("apps/runner-web/dist" if runner else "apps/web/dist")
        if not runner and not base.exists():
            base = ROOT / "infra/proxy/static"
        if runner and path.startswith("/runtime-manifests/"):
            inventory_file = RUNTIME_INVENTORIES.get(
                path.removeprefix("/runtime-manifests/")
            )
            if not inventory_file:
                self.send_error(404)
                return
            file = inventory_file
            data = file.read_bytes()
        elif runner and path.startswith("/runtime/v2/"):
            parts = path.split("/")
            asset = None
            if len(parts) == 5:
                for inventory_file in RUNTIME_INVENTORIES.values():
                    inventory = json.loads(inventory_file.read_text())
                    digest = hashlib.sha256(
                        json.dumps(
                            inventory, sort_keys=True, separators=(",", ":")
                        ).encode()
                    ).hexdigest()
                    if digest == parts[3]:
                        asset = next(
                            (
                                item
                                for item in inventory["assets"]
                                if item["name"] == parts[4]
                            ),
                            None,
                        )
                        break
            if not asset:
                self.send_error(404)
                return
            file = base / "runtime/v2" / parts[3] / parts[4]
            data = file.read_bytes()
            if (
                len(data) != asset["bytes"]
                or hashlib.sha256(data).hexdigest() != asset["sha256"]
            ):
                self.send_error(503)
                return
        elif runner and path.startswith("/runtime/"):
            name = path.removeprefix("/runtime/")
            inventory = json.loads(
                (
                    ROOT / "apps/runner-web/public/runtime-manifests/pyodide-core.json"
                ).read_text()
            )
            asset = next((a for a in inventory["assets"] if a["name"] == name), None)
            if not asset:
                self.send_error(404)
                return
            file = ROOT / "apps/runner-web/node_modules/pyodide" / name
            data = file.read_bytes()
            if hashlib.sha256(data).hexdigest() != asset["sha256"]:
                self.send_error(503)
                return
        else:
            file = (
                base / ("index.html" if path == "/" else path.lstrip("/"))
            ).resolve()
            if not file.is_relative_to(base.resolve()):
                self.send_error(404)
                return
            if not file.is_file() and not runner:
                file = base / "index.html"
            if not file.is_file():
                self.send_error(404)
                return
            data = file.read_bytes()
            if runner and file.name == "index.html":
                data = data.replace(b"%APP_ORIGIN%", APP.encode())
            elif not runner and file.name == "index.html":
                data = data.replace(b"__CODE_ALONG_RUNNER_ORIGIN__", RUNNER.encode())
        content_type = (
            "application/wasm"
            if file.suffix == ".wasm"
            else mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if runner and (
            path.startswith(("/runtime/v2/", "/runtime-manifests/")) or worker
        ):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header(
            "Cross-Origin-Resource-Policy", "cross-origin" if runner else "same-origin"
        )
        self.send_header(
            "Permissions-Policy",
            f'cross-origin-isolated=(self "{RUNNER}"), camera=(), microphone=()',
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        csp = (
            "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'"
            if worker
            else f"default-src 'none'; script-src 'self'; worker-src 'self'; frame-ancestors {APP}; base-uri 'none'"
            if runner
            else f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-src {RUNNER}; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        )
        self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(
        ROOT / ".runtime/certs/cert.pem", ROOT / ".runtime/certs/key.pem"
    )
    server = ThreadedHTTPSServer(("127.0.0.1", PORT), Handler, context)
    try:
        server.serve_forever()
    finally:
        server.server_close()

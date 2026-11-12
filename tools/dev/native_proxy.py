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

ROOT = Path(__file__).resolve().parents[2]
PORT = int(os.environ.get("CODE_ALONG_HTTPS_PORT", "8443"))
APP = f"https://127.0.0.1:{PORT}"
RUNNER = f"https://localhost:{PORT}"


class Handler(http.server.BaseHTTPRequestHandler):
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
        if runner and path.startswith("/runtime/"):
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
        content_type = (
            "application/wasm"
            if file.suffix == ".wasm"
            else mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
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
            else f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src {RUNNER}; worker-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        )
        self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(
        ROOT / ".runtime/certs/cert.pem", ROOT / ".runtime/certs/key.pem"
    )
    server.socket = context.wrap_socket(server.socket, server_side=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()

import http.client
import http.server
import socket
import socketserver
import ssl
import subprocess
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest

from tools.dev.https_server import ThreadedHTTPSServer


@pytest.fixture
def certificate(tmp_path):
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-out",
            str(cert),
            "-keyout",
            str(key),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    return context, ssl.create_default_context(cafile=str(cert))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"fixture ready")

    def log_message(self, *_args):
        pass


@contextmanager
def serving(context, handler=Handler, **kwargs):
    server = ThreadedHTTPSServer(("127.0.0.1", 0), handler, context, **kwargs)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_idle_tcp_peer_cannot_block_a_separate_verified_https_request(certificate):
    server_context, client_context = certificate
    with serving(server_context) as address:
        with socket.create_connection(address, timeout=2):
            client = http.client.HTTPSConnection(
                *address, context=client_context, timeout=2
            )
            try:
                client.request("GET", "/")
                response = client.getresponse()
                assert response.status == 200
                assert response.read() == b"fixture ready"
            finally:
                client.close()


def test_idle_handshake_is_closed_and_malformed_tls_does_not_stop_listener(certificate):
    server_context, client_context = certificate
    with serving(server_context, handshake_timeout=0.1) as address:
        with socket.create_connection(address, timeout=2) as idle:
            try:
                assert idle.recv(1) == b""
            except ConnectionResetError:
                pass
        with socket.create_connection(address, timeout=2) as malformed:
            malformed.sendall(b"not a TLS record")
        client = http.client.HTTPSConnection(
            *address, context=client_context, timeout=2
        )
        try:
            client.request("GET", "/")
            assert client.getresponse().status == 200
        finally:
            client.close()


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf")])
def test_invalid_handshake_timeout_is_rejected_before_binding(timeout):
    with pytest.raises(ValueError, match="positive and finite"):
        ThreadedHTTPSServer(
            ("127.0.0.1", 0),
            Handler,
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER),
            handshake_timeout=timeout,
        )


def test_native_websocket_tunnel_preserves_upgrade_bytes_and_bidirectional_data(
    certificate, monkeypatch
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tools/dev"))
    from tools.dev import native_proxy

    requests = []
    payload = bytes(range(256)) * 300
    greeting = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfirst-frame"

    class Upstream(socketserver.BaseRequestHandler):
        def handle(self):
            data = bytearray()
            while b"\r\n\r\n" not in data:
                data.extend(self.request.recv(4096))
            requests.append(bytes(data))
            self.request.sendall(greeting)
            received = bytearray()
            while len(received) < len(payload):
                part = self.request.recv(65536)
                if not part:
                    return
                received.extend(part)
            self.request.sendall(bytes(received))

    upstream = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Upstream)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv(
            "CODE_ALONG_NATIVE_COLLABORATION_PORT", str(upstream.server_address[1])
        )
        server_context, client_context = certificate
        with serving(server_context, native_proxy.Handler) as address:
            monkeypatch.setattr(native_proxy, "PORT", address[1])
            origin = f"https://127.0.0.1:{address[1]}"
            monkeypatch.setattr(native_proxy, "APP", origin)
            with socket.create_connection(address, timeout=3) as tcp:
                with client_context.wrap_socket(
                    tcp, server_hostname="127.0.0.1"
                ) as client:
                    client.sendall(
                        (
                            f"GET /collab HTTP/1.1\r\nHost: 127.0.0.1:{address[1]}\r\nOrigin: {origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: codealong_session=fixture\r\nX-Forwarded-Proto: attacker\r\n\r\n"
                        ).encode()
                    )
                    received = bytearray()
                    while len(received) < len(greeting):
                        part = client.recv(4096)
                        assert part
                        received.extend(part)
                    assert received == greeting
                    client.sendall(payload)
                    echoed = bytearray()
                    while len(echoed) < len(payload):
                        part = client.recv(65536)
                        assert part
                        echoed.extend(part)
                    assert bytes(echoed) == payload
            assert len(requests) == 1
            assert b"Cookie: codealong_session=fixture\r\n" in requests[0]
            assert b"X-Forwarded-Proto: https\r\n" in requests[0]
            assert b"attacker" not in requests[0]
    finally:
        upstream.shutdown()
        upstream.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize(
    "path,origin,status",
    [
        ("/collab", "https://attacker.invalid", 403),
        ("/collab?ticket=must-not-route", "valid", 404),
        ("/internal/v1/collaboration/consume/", "valid", 404),
    ],
)
def test_native_websocket_boundary_denies_wrong_origin_token_urls_and_private_routes(
    certificate, monkeypatch, path, origin, status
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tools/dev"))
    from tools.dev import native_proxy

    server_context, client_context = certificate
    with serving(server_context, native_proxy.Handler) as address:
        monkeypatch.setattr(native_proxy, "PORT", address[1])
        expected_origin = f"https://127.0.0.1:{address[1]}"
        monkeypatch.setattr(native_proxy, "APP", expected_origin)
        client = http.client.HTTPSConnection(
            *address, context=client_context, timeout=3
        )
        try:
            client.request(
                "GET",
                path,
                headers={
                    "Origin": expected_origin if origin == "valid" else origin,
                    "Upgrade": "websocket",
                    "Connection": "Upgrade",
                },
            )
            response = client.getresponse()
            assert response.status == status
            assert b"must-not-route" not in response.read()
        finally:
            client.close()


def test_native_static_responses_keep_large_tls_bodies_length_framed(
    certificate, tmp_path, monkeypatch
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tools/dev"))
    from tools.dev import native_proxy

    payload = bytes(range(256)) * 40_000
    root = tmp_path / "apps/web/dist"
    root.mkdir(parents=True)
    (root / "large.bin").write_bytes(payload)
    (root / "index.html").write_bytes(b"fixture home")
    monkeypatch.setattr(native_proxy, "ROOT", tmp_path)
    server_context, client_context = certificate
    with serving(server_context, native_proxy.Handler) as address:
        monkeypatch.setattr(native_proxy, "PORT", address[1])
        client = http.client.HTTPSConnection(
            *address, context=client_context, timeout=3
        )
        try:
            for path, expected in [("/large.bin", payload), ("/", b"fixture home")]:
                client.request("GET", path)
                connection = client.sock
                response = client.getresponse()
                assert response.version == 11
                assert response.status == 200
                assert response.getheader("Content-Length") == str(len(expected))
                assert response.read() == expected
                assert client.sock is connection
                assert not response.will_close
        finally:
            client.close()

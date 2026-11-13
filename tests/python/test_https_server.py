import http.client
import http.server
import socket
import ssl
import subprocess
import threading
from contextlib import contextmanager

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
def serving(context, **kwargs):
    server = ThreadedHTTPSServer(("127.0.0.1", 0), Handler, context, **kwargs)
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

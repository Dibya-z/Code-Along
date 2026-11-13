"""Bounded loopback WebSocket tunnel for disposable native product verification."""

import select
import socket
import threading
from http.server import BaseHTTPRequestHandler

CAPACITY = threading.BoundedSemaphore(32)
FORWARDED = {
    "host",
    "origin",
    "cookie",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
}


def proxy_websocket(handler: BaseHTTPRequestHandler, port: int, origin: str) -> None:
    if (
        handler.command != "GET"
        or handler.headers.get("Origin") != origin
        or handler.headers.get("Upgrade", "").lower() != "websocket"
        or handler.headers.get("Transfer-Encoding")
        or handler.headers.get("Content-Length", "0") != "0"
    ):
        handler.send_error(403)
        return
    if not CAPACITY.acquire(blocking=False):
        handler.send_error(503)
        return
    handler.close_connection = True
    upgraded = False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=3) as upstream:
            headers = [
                f"GET {handler.path} HTTP/1.1",
                "Upgrade: websocket",
                "Connection: Upgrade",
                "X-Forwarded-Proto: https",
            ]
            headers.extend(
                f"{key}: {value}"
                for key, value in handler.headers.items()
                if key.lower() in FORWARDED
            )
            upstream.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("latin-1"))
            response = bytearray()
            while b"\r\n\r\n" not in response:
                chunk = upstream.recv(4096)
                if not chunk or len(response) + len(chunk) > 16384:
                    raise OSError("Invalid loopback upgrade")
                response.extend(chunk)
            if not response.startswith(b"HTTP/1.1 101 "):
                handler.send_error(403)
                return
            handler.connection.sendall(response)
            upgraded = True
            upstream.settimeout(5)
            handler.connection.settimeout(5)
            while True:
                # SSL may already have decrypted bytes outside select's fd state.
                pending = getattr(handler.connection, "pending", lambda: 0)()
                readable = (
                    [handler.connection]
                    if pending
                    else select.select([handler.connection, upstream], [], [], 35)[0]
                )
                if not readable:
                    break
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    target = (
                        upstream if source is handler.connection else handler.connection
                    )
                    target.sendall(data)
    except (OSError, ValueError):
        if not upgraded:
            handler.send_error(503)
    finally:
        CAPACITY.release()

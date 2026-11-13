"""Loopback fixture HTTPS: an idle TLS peer must not stall the accept loop."""

import http.server
import math
import socket
import ssl


class ThreadedHTTPSServer(http.server.ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        handler: type[http.server.BaseHTTPRequestHandler],
        context: ssl.SSLContext,
        *,
        handshake_timeout: float = 10,
    ) -> None:
        if not math.isfinite(handshake_timeout) or handshake_timeout <= 0:
            raise ValueError("TLS handshake timeout must be positive and finite.")
        self.context = context
        self.handshake_timeout = handshake_timeout
        super().__init__(address, handler)

    def get_request(self) -> tuple[ssl.SSLSocket, tuple[str, int]]:
        connection, address = super().get_request()
        connection.settimeout(self.handshake_timeout)
        try:
            wrapped = self.context.wrap_socket(
                connection, server_side=True, do_handshake_on_connect=False
            )
        except BaseException:
            connection.close()
            raise
        return wrapped, address

    def finish_request(
        self,
        request: socket.socket | tuple[bytes, socket.socket],
        client_address: tuple[str, int],
    ) -> None:
        # ThreadingMixIn already moved this work off the listener thread. Its
        # process_request_thread finalizer closes successful and failed peers.
        if not isinstance(request, ssl.SSLSocket):
            return
        try:
            request.do_handshake()
        except OSError:
            return
        super().finish_request(request, client_address)

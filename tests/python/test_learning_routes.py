"""Exact learning socket routing without opening any listener."""

from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.mark.parametrize("path", ["/events", "/events/learning"])
def test_native_learning_and_legacy_event_sockets_use_only_api_upstream(
    monkeypatch, path
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tools/dev"))
    from tools.dev import native_proxy

    handler = object.__new__(native_proxy.Handler)
    handler.headers = {"Host": f"127.0.0.1:{native_proxy.PORT}"}
    handler.path = path
    handler.send_error = Mock()
    proxy = Mock()
    monkeypatch.setattr(native_proxy, "proxy_websocket", proxy)
    monkeypatch.setenv("CODE_ALONG_NATIVE_API_PORT", "18129")
    native_proxy.Handler.handle_request(handler)
    proxy.assert_called_once_with(handler, 18129, native_proxy.APP)
    handler.send_error.assert_not_called()


@pytest.mark.parametrize(
    "host,path",
    [
        ("runner", "/events/learning"),
        ("app", "/events/learning?user_id=forbidden"),
        ("app", "/internal/v1/learning/"),
    ],
)
def test_native_learning_socket_rejects_runner_query_and_internal_paths(
    monkeypatch, host, path
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "tools/dev"))
    from tools.dev import native_proxy

    handler = object.__new__(native_proxy.Handler)
    handler.headers = {
        "Host": f"{'localhost' if host == 'runner' else '127.0.0.1'}:{native_proxy.PORT}"
    }
    handler.path = path
    handler.send_error = Mock()
    proxy = Mock()
    monkeypatch.setattr(native_proxy, "proxy_websocket", proxy)
    native_proxy.Handler.handle_request(handler)
    handler.send_error.assert_called_once_with(404)
    proxy.assert_not_called()


def test_nginx_learning_socket_has_one_exact_app_route_and_preserves_runner_boundary():
    config = (
        Path(__file__).resolve().parents[2] / "infra/proxy/default.conf.template"
    ).read_text()
    location = "location = /events/learning {"
    assert config.count(location) == 1
    app, runner = config.split("server_name localhost;", 1)
    assert location in app and location not in runner
    block = app.split(location, 1)[1].split("}", 1)[0]
    assert "proxy_pass http://api:8000;" in block
    assert "proxy_set_header Upgrade $http_upgrade;" in block
    assert 'proxy_set_header Connection "upgrade";' in block
    assert "location ^~ /internal/ { return 404; }" in app
    assert "location / { return 404; }" in runner

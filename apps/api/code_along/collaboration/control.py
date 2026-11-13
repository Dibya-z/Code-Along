"""Bounded, nonredirecting requests to the explicitly configured private coordinator."""

import json
from typing import Any
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from django.conf import settings


class ControlUnavailable(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: Any, msg: Any, headers: Any, newurl: Any
    ) -> Request | None:
        return None


def post_control(
    path: str, body: dict[str, Any], *, maximum: int, timeout: float
) -> dict[str, Any]:
    if path not in {"/internal/v1/captures/", "/internal/v1/invalidations/"}:
        raise ControlUnavailable()
    url, secret = (
        settings.COLLABORATION_CONTROL_URL,
        settings.COLLABORATION_CONTROL_SECRET,
    )
    if not url or not secret:
        raise ControlUnavailable()
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    if len(encoded) > 6 * 1024 * 1024 + 64 * 1024:
        raise ControlUnavailable()
    request = Request(
        url + path,
        encoded,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(
            request, timeout=timeout
        ) as response:
            if response.status != 200:
                raise ControlUnavailable()
            raw = response.read(maximum + 1)
            if len(raw) > maximum:
                raise ControlUnavailable()
        value = json.loads(raw.decode("utf-8", errors="strict"))
        if not isinstance(value, dict):
            raise ControlUnavailable()
        return value
    except (OSError, URLError, ValueError):
        raise ControlUnavailable() from None

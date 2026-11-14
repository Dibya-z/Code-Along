"""No-argument delivery work; PostgreSQL remains the authoritative retry ledger."""

from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Protocol, cast

from config.celery import app
from django.conf import settings

from .dispatcher import DispatchUnavailable, dispatch_batch


class DispatchTask(Protocol):
    name: str
    app: object

    def __call__(self) -> dict[str, int]: ...
    def run(self) -> dict[str, int]: ...
    def apply_async(
        self,
        *,
        retry: bool,
        serializer: str,
        ignore_result: bool,
        expires: int,
        producer: object,
    ) -> object: ...


class ProducerPool(Protocol):
    def acquire(self, *, block: bool) -> AbstractContextManager[object]: ...


# Celery's dynamic decorator is given the one signature this application permits.
TaskDecorator = Callable[[Callable[[], dict[str, int]]], DispatchTask]
typed_task = cast(Callable[..., TaskDecorator], app.task)


@typed_task(
    name="code_along.events.dispatch_outbox", ignore_result=True, serializer="json"
)
def dispatch_outbox() -> dict[str, int]:
    try:
        return dispatch_batch().counts()
    except DispatchUnavailable:
        return {"unavailable": 1}


def wake_dispatcher() -> None:
    """Call only after commit; failure never substitutes eager application work."""
    if not getattr(settings, "CELERY_BROKER_URL", None):
        return
    try:
        pool = cast(ProducerPool, app.producer_pool)
        # Never queue an HTTP on-commit callback behind occupied producers.
        with pool.acquire(block=False) as producer:
            dispatch_outbox.apply_async(
                retry=False,
                serializer="json",
                ignore_result=True,
                expires=5,
                producer=producer,
            )
    except Exception:
        pass  # Periodic delivery retries committed rows; never expose broker details.

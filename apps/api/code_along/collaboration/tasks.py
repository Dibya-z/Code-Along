"""No-argument bounded maintenance on the explicitly configured trusted task app."""

from collections.abc import Callable
from typing import Protocol, cast

from config.celery import app

from .retention import RetentionUnavailable
from .retention import prune_checkpoint_receipts as prune


class RetentionTask(Protocol):
    name: str
    app: object

    def __call__(self) -> dict[str, int]: ...
    def run(self) -> dict[str, int]: ...


TaskDecorator = Callable[[Callable[[], dict[str, int]]], RetentionTask]
typed_task = cast(Callable[..., TaskDecorator], app.task)


@typed_task(
    name="code_along.collaboration.prune_checkpoint_receipts",
    ignore_result=True,
    serializer="json",
)
def prune_checkpoint_receipts() -> dict[str, int]:
    try:
        return prune(apply=True).counts()
    except RetentionUnavailable:
        return {"unavailable": 1}

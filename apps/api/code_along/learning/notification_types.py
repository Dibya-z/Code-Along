"""Pure server-only learning stream identity, independent of ORM and transport."""

import uuid
from dataclasses import dataclass
from typing import Literal

Audience = Literal["teaching", "participant"]
MAX_GENERATION = 9223372036854775807


class LearningDenied(Exception):
    def __init__(self) -> None:
        super().__init__("learning_denied")


class LearningUnavailable(Exception):
    def __init__(self) -> None:
        super().__init__("learning_unavailable")


@dataclass(frozen=True, slots=True)
class StreamIdentity:
    id: uuid.UUID
    assignment_id: uuid.UUID
    workspace_id: uuid.UUID
    audience_user_id: uuid.UUID | None
    participation_id: uuid.UUID | None


@dataclass(frozen=True, slots=True)
class LearningAccess:
    user_id: uuid.UUID
    stream: StreamIdentity


@dataclass(frozen=True, slots=True)
class LearningHead:
    access: LearningAccess
    generation: int


def stream_group(identity: StreamIdentity) -> str:
    if not all(
        isinstance(value, uuid.UUID)
        for value in (identity.id, identity.assignment_id, identity.workspace_id)
    ):
        raise LearningDenied()
    if identity.audience_user_id is None and identity.participation_id is None:
        return f"learning.t.{identity.assignment_id.hex}"
    if isinstance(identity.audience_user_id, uuid.UUID) and isinstance(
        identity.participation_id, uuid.UUID
    ):
        return (
            f"learning.p.{identity.assignment_id.hex}.{identity.audience_user_id.hex}"
        )
    raise LearningDenied()

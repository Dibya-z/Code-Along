import uuid
from typing import Any

from django.core.exceptions import ObjectDoesNotExist
from rest_framework.exceptions import APIException

from code_along.collaboration.services import AdmissionError, session_user
from code_along.projects.models import Project
from code_along.projects.policies import project_role, visible_projects

from .services import replay


class EventDenied(Exception):
    pass


def authority(
    session_key: str | None, project_id: uuid.UUID | None = None
) -> Project | None:
    try:
        user, _ = session_user(session_key)
        if project_id is None:
            return None
        project = visible_projects(user).select_related("workspace").get(id=project_id)
        project_role(project, user)
        return project
    except (AdmissionError, APIException, ObjectDoesNotExist):
        raise EventDenied() from None


def subscription(
    session_key: str | None, project_id: uuid.UUID, after: int | None
) -> dict[str, Any]:
    project = authority(session_key, project_id)
    assert project is not None
    return replay(project, after, limit=10, complete=True)

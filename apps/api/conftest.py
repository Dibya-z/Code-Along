"""Backend database access is possible only through this owned PG18 fixture."""

from collections.abc import Iterator
from typing import Any

import pytest
from django.db import connections

from tools.dev.postgres_cluster import postgres_cluster


@pytest.fixture(scope="session")
def django_db_modify_db_settings() -> Iterator[None]:
    with postgres_cluster() as cluster:
        database: dict[str, Any] = connections["default"].settings_dict
        database.update(
            NAME="postgres",
            USER="code_along_test",
            PASSWORD="",
            HOST=str(cluster.socket_directory),
            PORT=5432,
            CONN_MAX_AGE=0,
            OPTIONS={"connect_timeout": 2, "sslmode": "disable"},
        )
        database["TEST"]["NAME"] = "test_code_along_api"
        yield

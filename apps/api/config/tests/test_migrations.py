import secrets
import subprocess
import sys
from pathlib import Path

import pytest

from tools.dev.postgres_cluster import postgres_cluster


@pytest.mark.postgres
def test_fresh_schema_migrates_reverses_and_migrates_again() -> None:
    api = Path(__file__).resolve().parents[2]
    with postgres_cluster() as cluster:
        env = {
            k: v
            for k, v in cluster.environment().items()
            if not k.startswith("CODE_ALONG_")
        }
        env.update(
            DJANGO_SETTINGS_MODULE="config.settings.development",
            CODE_ALONG_SECRET_KEY=secrets.token_urlsafe(64),
            CODE_ALONG_DEBUG="false",
            CODE_ALONG_DB_NAME="postgres",
            CODE_ALONG_DB_USER="code_along_test",
            CODE_ALONG_DB_PASSWORD="",
            CODE_ALONG_DB_HOST=str(cluster.socket_directory),
        )

        def manage(*args: str) -> str:
            result = subprocess.run(
                [sys.executable, str(api / "manage.py"), *args],
                cwd=api,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            assert result.returncode == 0, "Owned migration command failed"
            assert env["CODE_ALONG_SECRET_KEY"] not in result.stdout + result.stderr
            return result.stdout

        assert "no issues" in manage("check")
        assert "No changes detected" in manage("makemigrations", "--check", "--dry-run")
        manage("migrate", "--noinput", "--verbosity", "0")
        assert (
            cluster.sql("SELECT to_regclass('public.accounts_user') IS NOT NULL") == "t"
        )
        assert cluster.sql("SELECT to_regclass('public.auth_user') IS NULL") == "t"
        assert (
            cluster.sql(
                "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='accounts_user' AND column_name='id'"
            )
            == "uuid"
        )
        assert (
            cluster.sql(
                "SELECT count(*) FROM django_migrations WHERE app='accounts' AND name='0001_initial'"
            )
            == "1"
        )
        manage("migrate", "accounts", "zero", "--noinput", "--verbosity", "0")
        assert cluster.sql("SELECT to_regclass('public.accounts_user') IS NULL") == "t"
        manage("migrate", "--noinput", "--verbosity", "0")
        assert (
            cluster.sql("SELECT to_regclass('public.accounts_user') IS NOT NULL") == "t"
        )

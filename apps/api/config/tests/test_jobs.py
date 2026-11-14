import ssl

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.jobs import job_settings


@pytest.mark.parametrize(
    "url",
    [
        "redis://redis:6379/2",
        "rediss://worker:private-password@jobs.example:6380/2",
        "redis://[::1]:6379/2",
        "redis+socket:///private/owned/redis.sock?virtual_host=2",
    ],
)
def test_explicit_notification_database_is_separate_from_coordination(url: str) -> None:
    assert job_settings({"CODE_ALONG_CELERY_BROKER_URL": url}) == {
        "CELERY_BROKER_URL": url
    }


@pytest.mark.parametrize(
    "url",
    [
        "amqp://guest:secret@host/2",
        "memory://",
        "redis://host/0",
        "redis://host",
        "redis://host:99999/2",
        "redis:///2",
        "redis://host/2?ssl_cert_reqs=none",
        "rediss://host/2#secret",
        "redis+socket:///private/owned/redis.sock?virtual_host=0",
        "redis+socket://host/private/redis.sock?virtual_host=2",
        "redis+socket:///?virtual_host=2",
        "redis://host/2\n",
        "redis://ho\x00st/2",
    ],
)
def test_invalid_brokers_fail_without_reflecting_credentials(url: str) -> None:
    with pytest.raises(ImproperlyConfigured) as failure:
        job_settings({"CODE_ALONG_CELERY_BROKER_URL": url})
    assert url not in str(failure.value)


def test_missing_broker_has_no_implicit_network_fallback() -> None:
    assert job_settings({}) == {"CELERY_BROKER_URL": None}
    from config.celery import app

    assert app.conf.broker_url == "disabled://"
    assert app.conf.result_backend is None
    assert app.conf.accept_content == ["json"]
    assert app.conf.task_ignore_result is True
    assert app.conf.worker_enable_remote_control is False
    assert app.conf.worker_prefetch_multiplier == 1
    assert app.conf.beat_schedule["dispatch-outbox"]["options"]["expires"] == 5


def test_tls_broker_keeps_certificate_and_hostname_verification() -> None:
    # Exercise the actual Kombu/redis configuration without opening a connection.
    from config.celery import create_app

    with create_app("rediss://jobs.example/2") as secure_app:
        connection = secure_app.connection_for_write()
        assert connection.ssl == {
            "ssl_cert_reqs": ssl.CERT_REQUIRED,
            "ssl_check_hostname": True,
        }

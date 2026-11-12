from unittest.mock import MagicMock, patch

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import Client, override_settings

from config.services import service_settings


def test_proxy_trust_is_explicit() -> None:
    assert service_settings({})["SECURE_PROXY_SSL_HEADER"] is None
    assert service_settings({"CODE_ALONG_TRUST_PROXY": "true"})[
        "SECURE_PROXY_SSL_HEADER"
    ] == ("HTTP_X_FORWARDED_PROTO", "https")
    with pytest.raises(ImproperlyConfigured):
        service_settings({"CODE_ALONG_TRUST_PROXY": "yes"})


@pytest.mark.parametrize(
    "url",
    [
        "http://bad",
        "redis://",
        "redis://host:99999",
        "redis://host/1",
        "redis://host/0?foo=bar",
    ],
)
def test_invalid_service_urls_are_not_reflected(url: str) -> None:
    with pytest.raises(ImproperlyConfigured) as error:
        service_settings({"CODE_ALONG_REDIS_URL": url})
    assert url not in str(error.value)


def test_readiness_fails_safely_without_database(client: Client) -> None:
    assert client.get("/health/ready/").json() == {"status": "unavailable"}
    assert client.get("/health/ready/").status_code == 503


@pytest.mark.postgres
@pytest.mark.django_db
def test_readiness_requires_both_services(client: Client) -> None:
    with override_settings(REDIS_CONNECTION_SECRET="redis://localhost:6379/0"):
        with patch("config.views.Redis.from_url") as factory:
            fake = MagicMock()
            factory.return_value.__enter__.return_value = fake
            fake.ping.return_value = True
            assert client.get("/health/ready/").status_code == 200
            fake.ping.side_effect = RuntimeError("private connection details")
            response = client.get("/health/ready/")
            assert response.status_code == 503 and response.json() == {
                "status": "unavailable"
            }

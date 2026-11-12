import pytest
from django.core.exceptions import ImproperlyConfigured

from config.accounts import account_settings


@pytest.mark.parametrize(
    "origin",
    [
        "http://app.example",
        "https://user:pass@app.example",
        "https://app.example/path",
        "https://app.example?secret=value",
        "https://app.example#fragment",
        "https://app example",
        "https://app.example\n",
        "https://app.example:99999",
    ],
)
def test_public_mail_origin_rejects_unsafe_values_without_echoing(origin: str) -> None:
    with pytest.raises(ImproperlyConfigured, match="exact HTTPS origin") as error:
        account_settings({"CODE_ALONG_APP_ORIGIN": origin}, production=True)
    assert origin not in str(error.value)


def test_production_has_no_implicit_external_mail_origin_or_credentials() -> None:
    values = account_settings({}, production=True)
    assert values["PUBLIC_APP_ORIGIN"] == ""
    assert (
        values["EMAIL_HOST"]
        == values["EMAIL_HOST_USER"]
        == values["EMAIL_HOST_PASSWORD"]
        == ""
    )
    assert values["EMAIL_USE_TLS"] is True
    assert values["ALLAUTH_TRUSTED_PROXY_COUNT"] == 0


def test_native_mail_directory_requires_absolute_path() -> None:
    with pytest.raises(ImproperlyConfigured):
        account_settings({"CODE_ALONG_MAIL_DIR": "relative"}, production=False)

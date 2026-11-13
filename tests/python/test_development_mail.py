"""The browser mail reader cannot target normal application accounts or stacks."""

import pytest

from tools.ci.development_mail import verification_link, verify_origin
from tools.dev.development import DevelopmentError


class TestMailEngine:
    __test__ = False

    def __init__(self):
        self.calls = []

    def compose(self, arguments, **options):
        self.calls.append((arguments, options))
        if arguments[0] == "port":
            return "127.0.0.1:18443\n"
        if "ls" in arguments:
            return "../../escape.log\nwrong.log\nright.log\n"
        if arguments[-1].endswith("wrong.log"):
            return "To: someone-else@example.test\n\nhttps://127.0.0.1:18443/auth/verify?key=wrong-fixture-key\n"
        return "To: development-case@example.test\n\nhttps://127.0.0.1:18443/auth/verify?key=fixture-key\n"


def test_verification_link_is_recipient_bound_and_uses_only_the_test_project():
    engine = TestMailEngine()
    assert (
        verification_link(
            engine,
            "code-along-dev-check",
            "https://127.0.0.1:18443",
            "development-case@example.test",
        )
        == "https://127.0.0.1:18443/auth/verify?key=fixture-key"
    )
    assert all(
        options["project"] == "code-along-dev-check" for _, options in engine.calls
    )
    assert not any("escape.log" in str(arguments) for arguments, _ in engine.calls)


@pytest.mark.parametrize(
    "project,origin",
    [
        ("code-along-dev", "https://127.0.0.1:18443"),
        ("unrelated-project", "https://127.0.0.1:18443"),
        ("code-along-ci", "https://example.com:18443"),
        ("code-along-ci", "http://127.0.0.1:18443"),
        ("code-along-ci", "https://127.0.0.1:18443/private"),
    ],
)
def test_primary_or_remote_scopes_are_rejected_before_reading_mail(project, origin):
    engine = TestMailEngine()
    with pytest.raises(DevelopmentError):
        verify_origin(engine, project, origin)
    assert not engine.calls


def test_published_port_must_match_the_browser_before_accounts_are_created():
    engine = TestMailEngine()
    with pytest.raises(DevelopmentError, match="published port"):
        verify_origin(engine, "code-along-dev-check", "https://127.0.0.1:8443")
    assert len(engine.calls) == 1


def test_real_recipient_cannot_be_read():
    engine = TestMailEngine()
    with pytest.raises(DevelopmentError, match="fake example.test"):
        verification_link(
            engine, "code-along-ci", "https://127.0.0.1:18443", "someone@example.com"
        )
    assert len(engine.calls) == 1

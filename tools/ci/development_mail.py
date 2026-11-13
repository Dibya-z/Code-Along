"""Read verification links only for fake accounts on explicitly owned test stacks."""

import argparse
import re
from email import message_from_string
from urllib.parse import urlsplit

from tools.dev.development import DevelopmentError, Engine

TEST_PROJECTS = {"code-along-ci", "code-along-dev-check"}


def verify_origin(engine: Engine, project: str, origin: str) -> None:
    parsed = urlsplit(origin)
    if (
        project not in TEST_PROJECTS
        or parsed.scheme != "https"
        or parsed.hostname != "127.0.0.1"
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise DevelopmentError(
            "Development mail requires an isolated test project and loopback origin."
        )
    binding = engine.compose(
        ["port", "proxy", "8443"], capture=True, project=project
    ).strip()
    if binding != f"127.0.0.1:{parsed.port or 443}":
        raise DevelopmentError(
            "Browser origin does not match this test project's published port."
        )


def verification_link(engine: Engine, project: str, origin: str, recipient: str) -> str:
    verify_origin(engine, project, origin)
    if not re.fullmatch(r"[a-z0-9-]+@example\.test", recipient):
        raise DevelopmentError(
            "Only fake example.test recipients may be read by browser tests."
        )
    names = engine.compose(
        ["exec", "-T", "api", "ls", "-1t", "/app/dev-mail"],
        capture=True,
        project=project,
    )
    for name in names.splitlines():
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.log", name):
            continue
        content = engine.compose(
            ["exec", "-T", "api", "cat", f"/app/dev-mail/{name}"],
            capture=True,
            project=project,
        )
        if message_from_string(content).get("To") != recipient:
            continue
        match = re.search(re.escape(origin) + r"/auth/verify\?key=[^\s]+", content)
        if match:
            return match[0]
    raise DevelopmentError("The requested private test message has not arrived.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", choices=sorted(TEST_PROJECTS), required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--recipient")
    args = parser.parse_args()
    try:
        engine = Engine()
        if args.recipient:
            print(verification_link(engine, args.project, args.origin, args.recipient))
        else:
            verify_origin(engine, args.project, args.origin)
    except (DevelopmentError, ValueError):
        raise SystemExit("Isolated development mail check failed.") from None


if __name__ == "__main__":
    main()

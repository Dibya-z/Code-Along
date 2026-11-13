"""Allow fast CI only for an unambiguous, nonempty prose-only Git diff."""

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[0-9a-f]{40}")
DOC_PATH = re.compile(r"(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\.md")
PROTECTED_DOCS = {
    "docs/architecture/decisions.md",
    "docs/architecture/checkpoint-persistence-proof.md",
    "docs/architecture/runner-threat-model.md",
}
LINK = re.compile(
    r"\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+\"[^\"\n]*\")?\s*\)"
    r"|^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))",
    re.MULTILINE,
)


@dataclass(frozen=True)
class Decision:
    mode: Literal["full", "docs"]
    reason: str


def git(root: Path, *arguments: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=True,
        capture_output=True,
        timeout=30,
    ).stdout


def is_prose(path: str) -> bool:
    if not DOC_PATH.fullmatch(path) or any(
        part in {".", "..", "AGENTS.md", "SECURITY.md"} for part in path.split("/")
    ):
        return False
    if path in PROTECTED_DOCS or path.startswith(("docs/protocols/", "docs/security/")):
        return False
    return path in {"README.md", "IMPLEMENTATION_PROGRESS.md"} or path.startswith(
        "docs/"
    )


def prose_diff(raw: bytes) -> bool:
    """Use raw NUL records with rename detection disabled to inspect both paths."""
    records = raw.split(b"\0")
    if records[-1] or len(records) < 3 or len(records) % 2 != 1:
        return False
    for index in range(0, len(records) - 1, 2):
        header = records[index].split()
        if (
            len(header) != 5
            or header[0] not in {b":100644", b":000000"}
            or header[1] not in {b"100644", b"000000"}
            or header[4] not in {b"A", b"M", b"D"}
        ):
            return False
        if not is_prose(records[index + 1].decode("utf-8")):
            return False
    return True


def checked_sha(value: Any) -> str:
    if not isinstance(value, str) or not SHA.fullmatch(value) or set(value) == {"0"}:
        raise ValueError("Missing or ambiguous commit")
    return value


def classify(
    event_name: str, event: dict[str, Any], checked_out_sha: str, root: Path = ROOT
) -> Decision:
    if event_name not in {"push", "pull_request"}:
        return Decision("full", "manual or unsupported event")
    try:
        current = checked_sha(checked_out_sha)
        if git(root, "rev-parse", "HEAD").decode().strip() != current:
            return Decision("full", "checkout does not match the event")
        if event_name == "push":
            base = checked_sha(event["before"])
            head = checked_sha(event["after"])
            if head != current:
                return Decision("full", "push does not match the checkout")
        else:
            pull_request = event["pull_request"]
            base = checked_sha(pull_request["base"]["sha"])
            head = checked_sha(pull_request["head"]["sha"])
            # The checked-out PR merge must contain the event's immutable tips.
            git(root, "merge-base", "--is-ancestor", base, current)
            git(root, "merge-base", "--is-ancestor", head, current)
            base = git(root, "merge-base", base, head).decode().strip()
        raw = git(
            root,
            "diff",
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--ignore-submodules=none",
            base,
            head,
            "--",
        )
        if prose_diff(raw):
            return Decision("docs", "only regular Markdown prose changed")
        return Decision("full", "source, protected, unknown or empty changes")
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        return Decision("full", "complete trustworthy diff unavailable")


def markdown_prose(text: str) -> str:
    """Mask code examples before checking inline and reference link targets."""
    lines = []
    fence = ""
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if marker:
            if not fence:
                fence = marker[1]
            elif (
                marker[1][0] == fence[0]
                and len(marker[1]) >= len(fence)
                and not marker[2].strip()
            ):
                fence = ""
            lines.append("")
        else:
            lines.append("" if fence else re.sub(r"(`+).*?\1", "", line))
    return "\n".join(lines)


def local_link_errors(root: Path, paths: list[str]) -> list[str]:
    """Check local file targets, not remote URL availability or heading anchors."""
    errors = []
    root = root.resolve()
    for path in paths:
        document = root / path
        prose = markdown_prose(document.read_text())
        for match in LINK.finditer(prose):
            target = next(group for group in match.groups() if group is not None)
            parsed = urlsplit(target)
            if parsed.scheme in {"http", "https", "mailto"} or parsed.netloc:
                continue
            if parsed.scheme:
                line = prose[: match.start()].count("\n") + 1
                errors.append(f"{path}:{line}: unsupported link scheme")
                continue
            if not parsed.path:
                continue
            destination = (document.parent / unquote(parsed.path)).resolve()
            if not destination.is_relative_to(root) or not destination.exists():
                line = prose[: match.start()].count("\n") + 1
                errors.append(f"{path}:{line}: missing or external local link target")
    return errors


def check_docs(root: Path = ROOT) -> None:
    paths = [
        path.decode("utf-8")
        for path in git(
            root,
            "ls-files",
            "-z",
            "--",
            "README.md",
            "IMPLEMENTATION_PROGRESS.md",
            "docs",
        ).split(b"\0")
        if path.endswith(b".md")
    ]
    if not paths:
        raise RuntimeError("No tracked documentation to check")
    subprocess.run(
        ["corepack", "pnpm", "exec", "prettier", "--check", *paths],
        cwd=root,
        check=True,
    )
    errors = local_link_errors(root, paths)
    if errors:
        raise RuntimeError("\n".join(errors))
    print(f"Checked formatting and local file links in {len(paths)} Markdown files")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-docs", action="store_true")
    arguments = parser.parse_args()
    if arguments.check_docs:
        check_docs()
        return
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    except (KeyError, OSError, ValueError):
        event = {}
    decision = classify(
        os.environ.get("GITHUB_EVENT_NAME", ""),
        event,
        os.environ.get("GITHUB_SHA", ""),
    )
    print(f"CI mode: {decision.mode} ({decision.reason})")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"mode={decision.mode}\n")


if __name__ == "__main__":
    main()

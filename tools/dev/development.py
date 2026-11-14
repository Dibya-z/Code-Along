"""Foreground local development and explicit control of this project's services."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import ssl
import subprocess
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from tools.dev.init_development import main as initialize

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "code-along-dev"


class DevelopmentError(RuntimeError):
    """Actionable local prerequisite or lifecycle failure without secret output."""


class DevelopmentBusy(DevelopmentError):
    """The foreground controller already holds the project lock."""


@dataclass(frozen=True)
class Engine:
    root: Path = ROOT

    @property
    def lima(self) -> Path:
        return self.root / ".runtime/tools/lima/bin/limactl"

    def environment(self) -> dict[str, str]:
        return {**os.environ, "LIMA_HOME": str(self.root / ".runtime/lima")}

    def require_local_docker(self) -> None:
        endpoint = os.environ.get("DOCKER_HOST")
        if endpoint is None:
            result = subprocess.run(
                [
                    "docker",
                    "context",
                    "inspect",
                    "--format",
                    '{{(index .Endpoints "docker").Host}}',
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if result.returncode:
                raise DevelopmentError("Could not inspect the local Docker context.")
            endpoint = result.stdout.strip()
        if not endpoint.startswith("unix://"):
            raise DevelopmentError(
                "Local development requires a local Docker Unix socket; choose a local context explicitly."
            )

    def lima_status(self) -> str:
        result = subprocess.run(
            [str(self.lima), "list", "--json", "code-along"],
            env=self.environment(),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode:
            raise DevelopmentError("Could not inspect the owned Lima VM.")
        try:
            rows = [
                json.loads(line) for line in result.stdout.splitlines() if line.strip()
            ]
            return next(
                str(row["status"]) for row in rows if row.get("name") == "code-along"
            )
        except (ValueError, KeyError, StopIteration, TypeError):
            raise DevelopmentError(
                "The owned Lima VM configuration/status is unavailable."
            ) from None

    def running(self) -> bool:
        if self.lima.is_file():
            return self.lima_status() == "Running"
        if not shutil.which("docker"):
            raise DevelopmentError(
                "Install a Docker engine with Compose, or restore this workstation's owned Lima setup."
            )
        self.require_local_docker()
        result = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return result.returncode == 0

    def compose(
        self,
        arguments: list[str],
        *,
        start: bool = False,
        capture: bool = False,
        project: str = PROJECT,
    ) -> str:
        if project not in {PROJECT, "code-along-ci", "code-along-dev-check"}:
            raise DevelopmentError("Unknown owned development/test project.")
        if project != PROJECT:
            allowed = arguments == ["port", "proxy", "8443"] or arguments == [
                "exec",
                "-T",
                "api",
                "ls",
                "-1t",
                "/app/dev-mail",
            ]
            if len(arguments) == 5 and arguments[:4] == ["exec", "-T", "api", "cat"]:
                allowed = bool(
                    re.fullmatch(r"/app/dev-mail/[A-Za-z0-9_-]+\.log", arguments[4])
                )
            if start or not allowed:
                raise DevelopmentError(
                    "Test projects are available for read-only verification only."
                )
        env_file = (
            ".runtime/dev-check.env" if project == "code-along-dev-check" else ".env"
        )
        command = [
            "docker",
            "compose",
            "-p",
            project,
            "--env-file",
            env_file,
            "-f",
            "infra/compose.yaml",
            "-f",
            "infra/compose.development.yaml",
            *arguments,
        ]
        if self.lima.is_file():
            if (
                start
                and not (self.root / ".runtime/lima/code-along/lima.yaml").is_file()
            ):
                raise DevelopmentError(
                    "The owned Lima VM configuration is missing; restore it before starting development."
                )
            command = [
                str(self.lima),
                "shell",
                *(["--start"] if start else []),
                "--workdir",
                str(self.root),
                "code-along",
                "env",
                f"CODE_ALONG_HTTPS_PORT={app_origin(self.root).rsplit(':', 1)[1]}",
                *command,
            ]
        elif not shutil.which("docker"):
            raise DevelopmentError(
                "Docker is unavailable; see the local development setup guide."
            )
        else:
            self.require_local_docker()
        result = subprocess.run(
            command,
            cwd=self.root,
            env=self.environment(),
            text=True,
            capture_output=capture,
            check=False,
        )
        if result.returncode:
            raise DevelopmentError(
                "Development service command failed; inspect the service output above."
            )
        return result.stdout if capture else ""

    def stop(self) -> None:
        if self.lima.is_file():
            state = self.lima_status()
            if state == "Stopped":
                print("Code Along is already stopped. Data volumes are preserved.")
                return
            try:
                if state == "Running":
                    self.compose(["stop"])
            finally:
                # Also release a VM interrupted during startup or a Docker failure.
                result = subprocess.run(
                    [str(self.lima), "stop", "code-along"],
                    env=self.environment(),
                    check=False,
                    timeout=90,
                )
                if result.returncode and self.lima_status() != "Stopped":
                    raise DevelopmentError("Could not stop the owned Code Along VM.")
        elif self.running():
            self.compose(["stop"])
        print("Code Along stopped. Database and mail volumes are preserved.")


def app_origin(root: Path = ROOT) -> str:
    configured = os.environ.get("CODE_ALONG_HTTPS_PORT")
    if configured is None:
        env = root / ".env"
        matches = (
            re.findall(r"^CODE_ALONG_HTTPS_PORT=(.*)$", env.read_text(), re.MULTILINE)
            if env.exists()
            else []
        )
        configured = matches[-1].strip().strip("\"'") if matches else "8443"
    if not configured.isdecimal() or not 1 <= int(configured) <= 65535:
        raise DevelopmentError(
            "CODE_ALONG_HTTPS_PORT must be a port number from 1 to 65535."
        )
    return f"https://127.0.0.1:{int(configured)}"


@contextmanager
def controller_lock(root: Path = ROOT, *, blocking: bool = False) -> Iterator[None]:
    state = root / ".runtime"
    state.mkdir(mode=0o700, exist_ok=True)
    with (state / "development.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise DevelopmentBusy(
                "Code Along development is already running in another terminal."
            ) from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def wait_ready(engine: Engine, timeout: float = 120) -> None:
    context = ssl.create_default_context(
        cafile=str(engine.root / ".runtime/certs/cert.pem")
    )
    deadline = time.monotonic() + timeout
    while True:
        try:
            with urlopen(
                app_origin(engine.root) + "/health/ready/", context=context, timeout=3
            ) as response:
                if response.status == 200:
                    return
        except (URLError, TimeoutError):
            pass
        if time.monotonic() >= deadline:
            raise DevelopmentError(
                "Development readiness timed out; run npm run status to inspect services."
            )
        time.sleep(0.5)


def dev(engine: Engine) -> None:
    with controller_lock(engine.root):
        initialize()
        stop_request = engine.root / ".runtime/development.stop"
        stop_request.unlink(missing_ok=True)
        previous = {
            item: signal.getsignal(item) for item in (signal.SIGTERM, signal.SIGHUP)
        }

        def interrupt(_signum: int, _frame: object) -> None:
            for item in previous:
                signal.signal(item, signal.SIG_IGN)
            raise KeyboardInterrupt

        for item in previous:
            signal.signal(item, interrupt)
        try:
            engine.compose(["up", "--build", "-d"], start=True)
            wait_ready(engine)
            print(f"\nCode Along: {app_origin(engine.root)}", flush=True)
            print(
                "Frontend updates automatically. API, database and Redis are connected.",
                flush=True,
            )
            print(
                "Keep this terminal open. Ctrl+C or npm run stop stops this project's services.",
                flush=True,
            )
            print(
                "Read local verification email with npm run mail -- --latest.",
                flush=True,
            )
            print(
                "Local certificate trust is a separate setup step; see the development guide.\n",
                flush=True,
            )
            next_check = time.monotonic() + 5
            while not stop_request.exists():
                time.sleep(0.25)
                if time.monotonic() >= next_check:
                    active = set(
                        engine.compose(
                            ["ps", "--status", "running", "--services"], capture=True
                        ).splitlines()
                    )
                    if not {
                        "api",
                        "db",
                        "redis",
                        "proxy",
                        "web-dev",
                        "collaboration",
                        "jobs",
                        "scheduler",
                    }.issubset(active):
                        raise DevelopmentError(
                            "A development service exited. Run npm run status and inspect its logs before restarting."
                        )
                    next_check = time.monotonic() + 5
        except KeyboardInterrupt:
            pass
        finally:
            try:
                engine.stop()
            finally:
                for item, handler in previous.items():
                    signal.signal(item, handler)
                stop_request.unlink(missing_ok=True)


def stop(engine: Engine) -> None:
    state = engine.root / ".runtime"
    state.mkdir(mode=0o700, exist_ok=True)
    (state / "development.stop").touch(mode=0o600)
    # The foreground controller owns shutdown when active. No PID guessing/killing.
    deadline = time.monotonic() + 120
    while True:
        try:
            with controller_lock(engine.root):
                engine.stop()
                return
        except DevelopmentBusy:
            if time.monotonic() >= deadline:
                raise DevelopmentError(
                    "The development controller has not finished shutdown; check its terminal."
                ) from None
            time.sleep(0.25)


def status(engine: Engine) -> None:
    if engine.running():
        engine.compose(["ps", "-a"])
        print(f"Application: {app_origin(engine.root)}")
    else:
        print("Code Along development VM/engine is stopped. Run npm run dev to start.")


def mail(engine: Engine, *, latest: bool) -> None:
    if not engine.running():
        raise DevelopmentError(
            "Start Code Along with npm run dev before reading its local mail."
        )
    output = engine.compose(
        ["exec", "-T", "api", "ls", "-1t", "/app/dev-mail"], capture=True
    )
    names = list(
        name
        for name in output.splitlines()
        if re.fullmatch(r"[A-Za-z0-9_-]+\.log", name)
    )
    if not names:
        print("No local email yet. Register an account in the application first.")
    elif latest:
        print(
            "Private local development email (contains an account-access link):",
            flush=True,
        )
        engine.compose(["exec", "-T", "api", "cat", f"/app/dev-mail/{names[0]}"])
    else:
        print(
            f"{len(names)} local message(s). Run npm run mail -- --latest to read the newest privately."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["dev", "stop", "status", "mail"])
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Explicitly print the newest private development email.",
    )
    args = parser.parse_args()
    if args.latest and args.action != "mail":
        parser.error("--latest is only available for mail")
    engine = Engine()
    try:
        if args.action == "dev":
            dev(engine)
        elif args.action == "stop":
            stop(engine)
        elif args.action == "status":
            status(engine)
        else:
            mail(engine, latest=args.latest)
        return 0
    except (DevelopmentError, OSError, subprocess.SubprocessError) as error:
        print(f"Code Along: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

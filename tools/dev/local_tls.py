"""Prepare local HTTPS separately from an explicit, owner-run OS trust operation."""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from types import FrameType
from urllib.error import HTTPError
from urllib.request import HTTPSHandler, ProxyHandler, build_opener

from tools.dev.development import ROOT, DevelopmentError, app_origin, controller_lock

HOSTS = ("127.0.0.1", "localhost")
RENEW_BEFORE = 30 * 24 * 60 * 60


def command(arguments: list[str], *, root: Path) -> str:
    result = subprocess.run(
        arguments,
        env={
            **os.environ,
            "CAROOT": str(root / ".runtime/local-ca"),
            "TRUST_STORES": "system",
        },
        capture_output=True,
        text=True,
        timeout=60,
        umask=0o077,
        check=False,
    )
    if result.returncode:
        raise DevelopmentError(
            "Local certificate operation failed; existing certificates are retained. "
            "Check OpenSSL/mkcert prerequisites and the local HTTPS guide."
        )
    return result.stdout


def mkcert(root: Path) -> str:
    owned = root / ".runtime/tools/mkcert/mkcert"
    executable = str(owned) if owned.is_file() else shutil.which("mkcert")
    if executable is None:
        raise DevelopmentError(
            "Install mkcert first (macOS: brew install mkcert), then rerun npm run tls:setup."
        )
    return executable


def validate(root: Path, certificates: Path) -> None:
    """Check key matching, CA signature, names, server purpose and renewal window."""
    cert, key = certificates / "cert.pem", certificates / "key.pem"
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    authority = root / ".runtime/local-ca/rootCA.pem"
    for path in (cert, authority):
        command(
            [
                "openssl",
                "x509",
                "-in",
                str(path),
                "-noout",
                "-checkend",
                str(RENEW_BEFORE),
            ],
            root=root,
        )
    for option, host in (("-verify_ip", HOSTS[0]), ("-verify_hostname", HOSTS[1])):
        command(
            [
                "openssl",
                "verify",
                "-CAfile",
                str(authority),
                "-purpose",
                "sslserver",
                option,
                host,
                str(cert),
            ],
            root=root,
        )


def require_stopped(root: Path) -> None:
    port = int(app_origin(root).rsplit(":", 1)[1])
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
    except ConnectionRefusedError:
        return
    raise DevelopmentError(
        "Run npm run stop before replacing local HTTPS certificates."
    )


@contextmanager
def finish_pair_update() -> Iterator[None]:
    """Defer normal termination until replacement/rollback leaves a consistent pair."""
    if threading.current_thread() is not threading.main_thread():
        raise DevelopmentError("Run certificate setup from its main-thread CLI.")
    previous = {
        signum: signal.getsignal(signum)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }
    if any(handler is None for handler in previous.values()):
        raise DevelopmentError(
            "Cannot safely defer a native certificate-setup signal handler."
        )
    pending: tuple[int, FrameType | None] | None = None

    def defer(signum: int, frame: FrameType | None) -> None:
        nonlocal pending
        if pending is None:
            pending = signum, frame

    try:
        for signum, handler in previous.items():
            if handler != signal.SIG_IGN:
                signal.signal(signum, defer)
        yield
    finally:
        for signum, handler in previous.items():
            if handler is not None:
                signal.signal(signum, handler)
        if pending is not None:
            handler = previous[signal.Signals(pending[0])]
            if callable(handler):
                handler(*pending)
            elif handler == signal.SIG_DFL:
                # Preserve conventional shell status and unwind temporary files/locks.
                raise SystemExit(128 + pending[0])


def setup(root: Path = ROOT) -> None:
    """Create/renew certificates without installing trust or changing application data."""
    with controller_lock(root):
        require_stopped(root)
        executable = mkcert(root)
        runtime = root / ".runtime"
        certificates = runtime / "certs"
        authority = runtime / "local-ca"
        authority.mkdir(mode=0o700, exist_ok=True)
        certificates.mkdir(mode=0o700, exist_ok=True)
        if authority.is_symlink() or certificates.is_symlink():
            raise DevelopmentError(
                "Local certificate directories must not be symlinks."
            )
        for directory, names in (
            (certificates, ("cert.pem", "key.pem")),
            (authority, ("rootCA.pem", "rootCA-key.pem")),
        ):
            paths = [directory / name for name in names]
            if any(path.is_symlink() for path in paths) or (
                any(path.exists() for path in paths)
                and not all(path.is_file() for path in paths)
            ):
                raise DevelopmentError(
                    "Incomplete or linked certificate/key pair; restore its matching files before setup."
                )
        if (certificates / "cert.pem").exists() and (authority / "rootCA.pem").exists():
            try:
                validate(root, certificates)
            except (DevelopmentError, OSError):
                pass  # Renew explicitly; never do this as part of normal startup.
            else:
                print("Existing local HTTPS certificate is valid; no files replaced.")
                trust(root)
                return
        with tempfile.TemporaryDirectory(prefix="tls-pending-", dir=runtime) as pending:
            staged = Path(pending)
            command(
                [
                    executable,
                    "-cert-file",
                    str(staged / "cert.pem"),
                    "-key-file",
                    str(staged / "key.pem"),
                    *HOSTS,
                ],
                root=root,
            )
            validate(root, staged)
            backup: Path | None = None
            if (certificates / "cert.pem").exists():
                backup = Path(tempfile.mkdtemp(prefix="tls-backup-", dir=runtime))
                for name in ("cert.pem", "key.pem"):
                    shutil.copy2(certificates / name, backup / name)
                    (backup / name).chmod(0o600)
            with finish_pair_update():
                try:
                    for name in ("cert.pem", "key.pem"):
                        (staged / name).chmod(0o600)
                        os.replace(staged / name, certificates / name)
                except BaseException:
                    for name in ("cert.pem", "key.pem"):
                        if backup is not None:
                            shutil.copy2(backup / name, certificates / name)
                        else:
                            (certificates / name).unlink(missing_ok=True)
                    raise
            if backup is not None:
                print(f"Previous certificate/key retained privately in {backup}.")
        print("Local HTTPS certificate prepared. No OS trust settings changed.")
        trust(root)


def fingerprint(path: Path) -> str:
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(path.read_text())).hexdigest()


def trust(root: Path = ROOT, *, action: str | None = None) -> None:
    """Default is review only; --install/--uninstall are explicit owner operations."""
    authority = root / ".runtime/local-ca/rootCA.pem"
    if not authority.is_file():
        raise DevelopmentError(
            "Run npm run tls:setup first to prepare the project-local CA."
        )
    print(f"Project CA SHA-256: {fingerprint(authority)}")
    print("Trust applies to this CA in the OS system store, not just this application.")
    print(
        "Keep .runtime/local-ca/rootCA-key.pem private; it can sign other certificates."
    )
    if action is None:
        print("Review, then run npm run tls:trust -- --install yourself to add trust.")
        print("Undo with npm run tls:trust -- --uninstall; CA files are retained.")
        return
    if action not in {"-install", "-uninstall"}:
        raise DevelopmentError("Unknown local certificate trust operation.")
    if action == "-install":
        validate(root, root / ".runtime/certs")
    # Interactive OS authorization stays with the owner; no password capture/sudo wrapper.
    subprocess.run(
        [mkcert(root), action],
        env={**os.environ, "CAROOT": str(authority.parent), "TRUST_STORES": "system"},
        check=True,
    )
    print(
        "Trust operation finished. Restart your browser; run npm run dev and npm run tls:check."
    )


def check(root: Path = ROOT) -> None:
    """Separate explicit CA/network validation from real OS trust evaluation."""
    certificates = root / ".runtime/certs"
    validate(root, certificates)
    authority = root / ".runtime/local-ca/rootCA.pem"
    context = ssl.create_default_context(cafile=str(authority))
    expected = fingerprint(certificates / "cert.pem")
    port = int(app_origin(root).rsplit(":", 1)[1])
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context))
    for host, path in ((HOSTS[0], "/health/ready/"), (HOSTS[1], "/")):
        with socket.create_connection(("127.0.0.1", port), timeout=5) as transport:
            with context.wrap_socket(transport, server_hostname=host) as secured:
                peer = secured.getpeercert(binary_form=True)
                if peer is None or hashlib.sha256(peer).hexdigest() != expected:
                    raise DevelopmentError(
                        "Proxy is serving an old/different certificate; restart npm run dev."
                    )
        with opener.open(f"https://{host}:{port}{path}", timeout=5) as response:
            if response.status != 200:
                raise DevelopmentError("Application/runner readiness failed.")
    try:
        opener.open(f"https://localhost:{port}/api/v1/me/", timeout=5).close()
    except HTTPError as error:
        with error:
            if error.code != 404:
                raise DevelopmentError("Runner must reject product APIs.") from None
    else:
        raise DevelopmentError("Runner must reject product APIs.")
    print(
        "Explicit-CA TLS, served certificate, readiness and runner API separation passed."
    )
    if platform.system() == "Darwin":
        # No -r override: only the actual OS trust store may anchor these checks.
        for host in HOSTS:
            result = subprocess.run(
                [
                    "/usr/bin/security",
                    "verify-cert",
                    "-q",
                    "-L",
                    "-c",
                    str(certificates / "cert.pem"),
                    "-p",
                    "ssl",
                    "-n",
                    host,
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            if result.returncode:
                raise DevelopmentError(
                    "macOS trust is not verified. Review npm run tls:trust, install explicitly, "
                    "then restart your browser and rerun this check."
                )
    else:
        # Python/OpenSSL defaults differ from browser stores. Use the OS curl defaults.
        environment = {
            key: value
            for key, value in os.environ.items()
            if key not in {"CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR"}
        }
        for host, path in ((HOSTS[0], "/health/ready/"), (HOSTS[1], "/")):
            subprocess.run(
                [
                    "curl",
                    "--disable",
                    "--noproxy",
                    "*",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "5",
                    "--output",
                    os.devnull,
                    f"https://{host}:{port}{path}",
                ],
                env=environment,
                check=True,
            )
    print(
        "OS trust verified for both local names. Confirm the address bar in your restarted browser."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["setup", "trust", "check"])
    operations = parser.add_mutually_exclusive_group()
    operations.add_argument(
        "--install", action="store_true", help="Explicitly add this CA to OS trust."
    )
    operations.add_argument(
        "--uninstall",
        action="store_true",
        help="Explicitly remove this CA from OS trust.",
    )
    args = parser.parse_args()
    if (args.install or args.uninstall) and args.action != "trust":
        parser.error("Trust-store changes are only available through tls:trust.")
    try:
        if args.action == "setup":
            setup()
        elif args.action == "trust":
            trust(
                action="-install"
                if args.install
                else "-uninstall"
                if args.uninstall
                else None
            )
        else:
            check()
    except (DevelopmentError, OSError, subprocess.SubprocessError) as error:
        print(f"Code Along HTTPS: {error}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

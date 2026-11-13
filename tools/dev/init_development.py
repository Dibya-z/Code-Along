"""Create owned development-only secrets/TLS files; never overwrite existing state."""

import fcntl
import os
import re
import secrets
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECRET_KEYS = (
    "CODE_ALONG_SECRET_KEY",
    "CODE_ALONG_DB_PASSWORD",
    "CODE_ALONG_COLLABORATION_SECRET",
    "CODE_ALONG_COLLABORATION_CONTROL_SECRET",
    "CODE_ALONG_COLLABORATION_DB_PASSWORD",
)


def prepare_environment(path: Path) -> None:
    """Add missing development credentials atomically, preserving existing values."""
    descriptor = os.open(
        path.with_name(".env.setup.lock"),
        os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _prepare_environment(path)


def _prepare_environment(path: Path) -> None:
    if path.is_symlink() or path.exists() and not path.is_file():
        raise RuntimeError("Development environment must be a regular private file")
    existing = path.read_bytes() if path.exists() else b""
    text = existing.decode("utf-8")
    values: dict[str, str] = {}
    for line in text.splitlines():
        match = re.match(r"\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=(.*)$", line)
        if match and match[1] in SECRET_KEYS:
            if match[1] in values or not match[2].strip().strip("\"'"):
                raise RuntimeError(
                    "Existing development credentials are ambiguous or empty"
                )
            values[match[1]] = match[2]
    additions = [
        f"{key}={secrets.token_urlsafe(64 if key.endswith('SECRET_KEY') else 32)}\n"
        for key in SECRET_KEYS
        if key not in values
    ]
    if not re.search(r"(?m)^\s*CODE_ALONG_HTTPS_PORT\s*=", text):
        additions.append("CODE_ALONG_HTTPS_PORT=8443\n")
    if not additions:
        return
    data = existing + (b"\n" if existing and not existing.endswith(b"\n") else b"")
    data += "".join(additions).encode()
    descriptor, name = tempfile.mkstemp(prefix=".env-stage-", dir=path.parent)
    staged = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


def main() -> None:
    runtime = ROOT / ".runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    certs = runtime / "certs"
    certs.mkdir(mode=0o700, exist_ok=True)
    prepare_environment(ROOT / ".env")
    if not (certs / "cert.pem").exists():
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-keyout",
                str(certs / "key.pem"),
                "-out",
                str(certs / "cert.pem"),
                "-days",
                "30",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    print(
        "Development environment prepared. Secrets and local TLS material are ignored by Git."
    )


if __name__ == "__main__":
    main()

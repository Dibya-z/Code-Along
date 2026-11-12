"""Create owned development-only secrets/TLS files; never overwrite existing state."""

import os
import secrets
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    runtime = ROOT / ".runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    certs = runtime / "certs"
    certs.mkdir(mode=0o700, exist_ok=True)
    env = ROOT / ".env"
    if not env.exists():
        fd = os.open(env, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as output:
            output.write(
                f"CODE_ALONG_SECRET_KEY={secrets.token_urlsafe(64)}\nCODE_ALONG_DB_PASSWORD={secrets.token_urlsafe(32)}\nCODE_ALONG_HTTPS_PORT=8443\n"
            )
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

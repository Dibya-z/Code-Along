"""Point-in-time PyPI advisory check for backend and reviewed browser packages."""

import hashlib
import json
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


def browser_packages() -> list[dict[str, object]]:
    profile = json.loads(
        (
            ROOT / "packages/runtime-profiles/manifests/pyodide-scientific.json"
        ).read_text()
    )
    lock_bytes = (
        ROOT / "apps/runner-web/node_modules/pyodide/pyodide-lock.json"
    ).read_bytes()
    pinned = next(
        asset for asset in profile["assets"] if asset["name"] == "pyodide-lock.json"
    )
    if hashlib.sha256(lock_bytes).hexdigest() != pinned["sha256"]:
        raise RuntimeError("Browser package lock integrity check failed")
    lock = json.loads(lock_bytes)
    wheels = {
        asset["name"]: asset["sha256"]
        for asset in profile["assets"]
        if asset["name"].endswith(".whl")
    }
    packages: list[dict[str, object]] = []
    for name, package in lock["packages"].items():
        if package["file_name"] in wheels:
            if package["sha256"] != wheels[package["file_name"]]:
                raise RuntimeError("Browser package inventory integrity check failed")
            packages.append({"name": name, "version": package["version"]})
    if len(packages) != len(wheels) or not packages:
        raise RuntimeError("Browser package inventory is incomplete")
    return packages


def check(package: dict[str, object]) -> tuple[str, list[dict[str, object]]]:
    name = str(package["name"])
    version = str(package["version"])
    url = f"https://pypi.org/pypi/{quote(name, safe='')}/{quote(version, safe='')}/json"
    for attempt in range(3):
        try:
            with urlopen(
                Request(url, headers={"User-Agent": "Code-Along-dependency-check"}),
                timeout=10,
            ) as response:
                metadata = json.load(response)
            return f"{name}=={version}", metadata["vulnerabilities"]
        except Exception:
            if attempt == 2:
                raise
            time.sleep(0.5)
    raise RuntimeError("Unreachable advisory check state")


def main() -> None:
    with (ROOT / "uv.lock").open("rb") as source:
        lock = tomllib.load(source)
    packages = [
        p
        for p in lock["package"]
        if p["source"].get("registry") == "https://pypi.org/simple"
    ]
    if not packages:
        raise RuntimeError("No public PyPI lock entries to check")
    packages.extend(browser_packages())
    issues = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for name, advisories in pool.map(check, packages):
            if advisories:
                issues.append((name, [a["id"] for a in advisories]))
    if issues:
        for name, ids in issues:
            print(name, ", ".join(str(item) for item in ids))
        raise SystemExit("Published Python advisories require review")
    print(
        f"Checked {len(packages)} exact public PyPI/backend and reviewed browser package entries; no known advisories reported."
    )


if __name__ == "__main__":
    main()

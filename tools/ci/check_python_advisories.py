"""Point-in-time PyPI advisory check for exact public-index entries in uv.lock."""

import json
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]


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
        f"Checked {len(packages)} exact public PyPI lock entries; no known advisories reported."
    )


if __name__ == "__main__":
    main()

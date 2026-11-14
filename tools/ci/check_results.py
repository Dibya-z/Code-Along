"""Keep one stable required status for every applicable CI job."""

import json
import os

JOBS = frozenset({"changes", "source", "browser", "compose"})


def failures(needs: object) -> list[str]:
    if not isinstance(needs, dict) or set(needs) != JOBS:
        return ["The complete CI job result set is unavailable."]
    changes = needs["changes"]
    outputs = changes.get("outputs") if isinstance(changes, dict) else None
    mode = outputs.get("mode") if isinstance(outputs, dict) else None
    errors = []
    if not isinstance(mode, str) or mode not in {"docs", "full"}:
        errors.append("The CI classification mode is unavailable or invalid.")
    docs = (
        isinstance(changes, dict)
        and changes.get("result") == "success"
        and mode == "docs"
    )
    for job in sorted(JOBS):
        value = needs[job]
        result = value.get("result") if isinstance(value, dict) else None
        if result == "success":
            continue
        if docs and job in {"browser", "compose"} and result == "skipped":
            continue
        errors.append(f"The {job} job did not finish an applicable check successfully.")
    return errors


def main() -> None:
    try:
        needs = json.loads(os.environ["NEEDS_JSON"])
    except (KeyError, ValueError):
        needs = None
    errors = failures(needs)
    if errors:
        for error in errors:
            print(error)
        raise SystemExit(1)
    print("All applicable source, browser and Compose checks passed.")


if __name__ == "__main__":
    main()

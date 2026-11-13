"""Generate static contracts using isolated, non-connectable settings, never a live DB."""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings.schema"
    sys.path.insert(0, str(ROOT / "apps/api"))
    import django

    django.setup()
    from allauth.headless.spec.internal.schema import get_schema
    from drf_spectacular.drainage import GENERATOR_STATS
    from drf_spectacular.generators import SchemaGenerator
    from drf_spectacular.validation import validate_schema

    product = SchemaGenerator().get_schema(request=None, public=True)
    validate_schema(product)
    if GENERATOR_STATS:
        raise RuntimeError("Schema generation reported errors or warnings")
    auth = get_schema()
    # Upstream's UUID example is random; normalize only that documentation example.
    example = auth["components"]["examples"]["User"]["value"]
    if isinstance(example.get("id"), str):
        example["id"] = "00000000-0000-4000-8000-000000000001"
        auth["components"]["schemas"]["User"]["properties"]["id"]["example"] = example[
            "id"
        ]
    output = ROOT / "docs/api"
    output.mkdir(parents=True, exist_ok=True)
    for name, schema in [("openapi.json", product), ("auth-openapi.json", auth)]:
        path = output / name
        if arguments.check:
            if json.loads(path.read_text()) != schema:
                raise RuntimeError(
                    f"API contract drift in {name}; regenerate before committing."
                )
        else:
            path.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
    print(
        "Generated product and configured browser-auth contracts without connecting to services."
    )


if __name__ == "__main__":
    main()

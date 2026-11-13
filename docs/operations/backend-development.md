# Django backend development

The product backend under `apps/api/` implements account/session flows, verified-account permissions, workspaces, recipient-bound invitations, project/file metadata and explicit project sharing. Use the [HTTPS development stack](development-stack.md) for the complete application. This guide covers backend boundaries and direct management commands; nothing here authorizes a deployment.

## Layout and versions

| Location                                     | Responsibility                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/manage.py`                         | Django commands; production settings are the default unless explicitly selected                   |
| `apps/api/config/environment.py`             | `load_environment`: validate configuration without connecting to services or reading dotenv files |
| `apps/api/config/settings/`                  | Base, explicit development, production, test and offline schema variants                          |
| `apps/api/config/accounts.py`, `services.py` | Mail/origin and Redis/proxy configuration                                                         |
| `apps/api/config/asgi.py`                    | HTTP through Channels; reject unimplemented product WebSockets                                    |
| `apps/api/config/urls.py`, `views.py`        | API routing, liveness/readiness and generic non-debug errors                                      |
| `apps/api/code_along/accounts/`              | UUID user, allauth adapter/forms, verified identity and CSRF endpoints                            |
| `apps/api/code_along/workspaces/`            | Membership, owner policy, invitations and transactional services                                  |
| `apps/api/code_along/projects/`              | Runtime catalog, project/file/document metadata, grants and sharing                               |
| `apps/api/code_along/common/`                | Strict request bodies, pagination and public response/schema projections                          |
| `apps/api/conftest.py`                       | Owned PostgreSQL 18 test database; never an external/shared database                              |

Python 3.13.12 and uv 0.10.9 are pinned. Runtime versions include Django 5.2.19 LTS, DRF 3.18.3, Channels 4.3.2, Daphne 4.2.3, psycopg/binary 3.3.9, allauth 65.22.0 and drf-spectacular 0.30.0. Check `apps/api/pyproject.toml` and `uv.lock` for the full exact graph. The root/API are non-packaged uv workspaces: Django runs from its source directory, with no editable/third-party source builds or global package installation.

## Configuration

From the repository root:

```sh
export UV_CACHE_DIR="$PWD/.uv-cache"
uv sync --locked --no-python-downloads
```

`apps/api/.env.example` is a placeholder template. The application does not load dotenv automatically; Compose supplies its ignored generated `.env`. Never commit populated credentials or print resolved configuration into shared logs.

| Variable                                   | Development                                                              | Production                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `DJANGO_SETTINGS_MODULE`                   | Explicit `config.settings.development`                                   | Entry points default to `config.settings.production`                     |
| `CODE_ALONG_SECRET_KEY`                    | Required generated secret, at least 50 characters; placeholders rejected | Same; no fallback key                                                    |
| `CODE_ALONG_DEBUG`                         | Literal `true`/`false`; Compose explicitly uses `false`                  | Must be `false`                                                          |
| `CODE_ALONG_ALLOWED_HOSTS`                 | Exact local hosts by default                                             | Explicit exact hosts; no wildcard, URL, port or empty entry              |
| `CODE_ALONG_DB_NAME`, `CODE_ALONG_DB_USER` | Explicit PostgreSQL identifiers                                          | Same                                                                     |
| `CODE_ALONG_DB_HOST`                       | Explicit hostname, bracketed IPv6 or absolute socket directory           | Same; TCP requires verified TLS                                          |
| `CODE_ALONG_DB_PORT`                       | 1–65535, default 5432                                                    | Same                                                                     |
| `CODE_ALONG_DB_PASSWORD`                   | Required for TCP; empty only for explicitly configured Unix sockets      | Required                                                                 |
| `CODE_ALONG_DB_SSLMODE`                    | `disable` or `verify-full`                                               | `verify-full`, with deployment trust roots                               |
| `CODE_ALONG_REDIS_URL`                     | Owned Redis connection; Compose/native supply it                         | Explicit trusted Redis; readiness fails if unavailable                   |
| `CODE_ALONG_TRUST_PROXY`                   | Disabled unless explicitly `true` behind the owned stripping proxy       | Enable only behind a reviewed proxy; do not expose its API port directly |
| `CODE_ALONG_APP_ORIGIN`                    | Exact local HTTPS origin for links and CSRF                              | Explicit exact HTTPS application origin                                  |
| `CODE_ALONG_MAIL_DIR`                      | Optional private local file store                                        | Not the production mail delivery path                                    |

See [account configuration](authentication.md) for SMTP/sender settings. Production cookies use Secure/HttpOnly host-only sessions and `__Host-` cookie names. Development cookies have local names and development settings; the complete stack still uses HTTPS. Runner origins are never trusted for product CSRF or account APIs.

If managing your own local database rather than Compose, supply the above development variables and run:

```sh
export DJANGO_SETTINGS_MODULE=config.settings.development
uv run --locked --offline python apps/api/manage.py check
uv run --locked --offline python apps/api/manage.py makemigrations --check --dry-run
uv run --locked --offline python apps/api/manage.py migrate
uv run --locked --offline --directory apps/api daphne -b 127.0.0.1 -p 8000 config.asgi:application
```

These commands migrate only the database **you configure**. Do not use a reference/shared database. `uv sync`, imports and server startup do not provision a database automatically. The direct HTTP API is for controlled development; the HTTPS proxy serves the frontend and complete credential flow.

`/health/live/` proves process liveness without a DB query. `/health/ready/` checks PostgreSQL and Redis, returning a generic 503 on failure. Product routes live under `/api/v1/`; no Django admin site is enabled. Unsupported WebSockets close without acceptance. Event transport and collaboration admission remain M3.

## Identity and policy invariants

`AUTH_USER_MODEL = accounts.User` precedes the first migration. It uses UUID identity, canonical case-insensitive ASCII/IDNA email and bounded nonblank display names; email is not a public roster label. Password hashing/session validation use framework machinery, with mandatory allauth primary-email verification for product access. Staff/superuser flags do not bypass workspace/project policies. See [account flows](authentication.md).

Django owns product migrations; M0 `checkpoint_proof` tables remain disposable fixtures. Workspace membership and private project grants are separate. Mutations serialize on the workspace before project/invitation rows. Owner-transfer/removal guards, deferred parent/generation constraints, explicit metadata versions, source/path quotas and digest-only invitation state are tested against real PostgreSQL. See [workspace](workspaces.md), [invitation](invitations.md) and [project](projects.md) guides.

Learner source is immutable starter data in M1. It is never evaluated by Django or ordinary application workers. The editor/run integration is M2; binary collaboration state, leases and durable receipts are M3. Browser practice has no grade authority.

## Tests, contracts and types

```sh
export CODE_ALONG_POSTGRES_BIN=/absolute/path/to/postgresql-18/bin
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .
uv run --locked --offline mypy
DJANGO_SETTINGS_MODULE=config.settings.test uv run --locked --offline python -m pytest -q
corepack pnpm api:check
```

Use a trusted native tool path. Test settings initially point to a non-connectable socket and ignore application credentials. Marked integration cases allocate private PG18 clusters/test databases, migrate them and clean up afterward. Fresh/reverse/reapply/drift tests exercise all product migrations; no existing database is migrated. Config/HTTP/startup cases do not need a pre-existing service. A real Daphne child adopts an owned ephemeral loopback socket and is reaped after the test. Unit-only `-m 'not postgres'` remains explicitly partial coverage.

The M1 final Python suite has **203 tests**. Strict mypy checks **64** API source/test/entrypoint/fixture files; generated migrations are verified by execution/drift tests. Separate JavaScript, native transport and browser gates remain required; see the [M1 report](../architecture/m1-validation.md). Offline OpenAPI generation uses non-connectable schema settings, not a running database. Warnings and generated drift fail checks; see [API contracts](../api/README.md).

The CI workflow repeats the gates on Ubuntu and builds a fresh disposable Compose stack. Local native evidence uses macOS arm64/PostgreSQL 18.7, while the local development containers run Linux arm64. The expected production `check --deploy` follow-up is `security.W004`: HSTS remains unset pending domain/deployment policy. Production SMTP delivery, database TLS deployment, backups/load/retention and operational readiness still need their later reviews. Nothing is deployed.

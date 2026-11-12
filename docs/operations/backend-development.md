# Django backend foundation

M1.1 adds the first product backend under `apps/api/`. It defines account identity, validated settings, an initial migration and HTTP/ASGI bootstrap. Login/registration, workspace/project APIs, Redis delivery, frontend screens and production deployment remain later units.

## Layout and versions

| Location                              | Responsibility                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/api/manage.py`                  | Django commands; defaults to production settings unless explicitly selected                     |
| `apps/api/config/environment.py`      | `load_environment`: validate inputs without opening service connections or reading dotenv files |
| `apps/api/config/settings/`           | Shared structure plus development, test and production variants                                 |
| `apps/api/config/asgi.py`             | Django HTTP through Channels routing; reject unimplemented WebSocket subscriptions              |
| `apps/api/config/urls.py`, `views.py` | GET/HEAD `/health/live/`; generic non-debug 404/500 responses                                   |
| `apps/api/code_along/accounts/`       | `User`, `UserManager`, initial migration and invariant tests                                    |
| `apps/api/conftest.py`                | Owned PostgreSQL 18 integration-test database; never select an external/shared database         |

Python stays 3.13.12 and uv 0.10.9. Runtime pins: Django 5.2.19 LTS, DRF 3.18.3, Channels 4.3.2, Daphne 4.2.3 and psycopg/binary 3.3.9. Tests use pytest-django 4.14.0; backend type checking uses mypy 1.19.1 with Django stubs/ext 5.2.9. That mypy line satisfies the stubs' `<1.20` compatibility requirement. The root `uv.lock` includes exact transitive versions and artifact hashes.

The root and API are non-packaged uv workspace projects. The API is a runnable Django application, not a published library. Standard `manage.py`/Daphne entry points run with the API source directory; pytest and mypy have explicit API source paths. This preserves uv 0.10.9's existing `no-build` policy: third-party source builds and editable package builds are not enabled. No global Python installation is changed. [uv workspaces](https://docs.astral.sh/uv/concepts/projects/workspaces/), [Django 5.2.19 security release](https://www.djangoproject.com/weblog/2026/nov/03/security-releases/).

## Configuration

From the repository root:

```sh
export UV_CACHE_DIR="$PWD/.uv-cache"
uv sync --locked --no-python-downloads
```

Use `apps/api/.env.example` as a **placeholder template**, replacing the values and supplying them through the shell or service manager. The application does not automatically source `.env`, and the example secret deliberately fails validation. Do not commit a populated environment file or print real secrets in diagnostics.

| Variable                                   | Development                                                                       | Production                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `DJANGO_SETTINGS_MODULE`                   | Explicit `config.settings.development`                                            | Entry points default to `config.settings.production`                             |
| `CODE_ALONG_SECRET_KEY`                    | Required generated secret, at least 50 characters; obvious placeholders rejected  | Same; no fallback/test key                                                       |
| `CODE_ALONG_DEBUG`                         | `true` by default; only literal `true`/`false`                                    | Must be `false`                                                                  |
| `CODE_ALONG_ALLOWED_HOSTS`                 | Defaults to localhost, 127.0.0.1, [::1]                                           | Explicit comma-separated exact hostnames; no wildcard, URL, port or empty member |
| `CODE_ALONG_DB_NAME`, `CODE_ALONG_DB_USER` | Explicit PostgreSQL identifiers                                                   | Same                                                                             |
| `CODE_ALONG_DB_HOST`                       | Explicit hostname, bracketed IPv6 or absolute socket directory                    | Same; TLS policy below applies to TCP                                            |
| `CODE_ALONG_DB_PORT`                       | Decimal 1–65535; defaults 5432                                                    | Same                                                                             |
| `CODE_ALONG_DB_PASSWORD`                   | Required for TCP; empty allowed only for explicitly configured local Unix sockets | Required                                                                         |
| `CODE_ALONG_DB_SSLMODE`                    | `disable` by default; `verify-full` also supported                                | Must be `verify-full`; provide the appropriate libpq trust roots at deployment   |

Generate a local secret without placing a constant key in source:

```sh
export CODE_ALONG_SECRET_KEY="$(uv run --locked --offline python -c 'import secrets; print(secrets.token_urlsafe(64))')"
```

Set the remaining variables to your **own** local PostgreSQL 18 database, user and connection settings. No development database or credentials are implicitly created by `uv sync`, imports or server startup. Compose provisioning and proxy/routing are M1.2; this unit's tests need no pre-existing database service.

Once your own development database is configured, the actual management/start commands are:

```sh
export DJANGO_SETTINGS_MODULE=config.settings.development
uv run --locked --offline python apps/api/manage.py check
uv run --locked --offline python apps/api/manage.py makemigrations --check --dry-run
uv run --locked --offline python apps/api/manage.py migrate
uv run --locked --offline --directory apps/api daphne -b 127.0.0.1 -p 8000 config.asgi:application
```

Visit `http://127.0.0.1:8000/health/live/` for `{"status":"ok"}`. This is process liveness, **not database readiness or the product UI**. Unknown paths return 404; there is no admin/login/project route. Unimplemented WebSockets close without acceptance. No Redis or in-memory delivery substitute is enabled. Readiness, event transport and product endpoints arrive in their owning units.

## Identity invariants

`AUTH_USER_MODEL = accounts.User` is selected before the first migration. `accounts/migrations/0001_initial.py` creates the UUID account table; framework group/permission dependencies are legitimate Django auth tables, while stock `auth_user` is never created. The app owns its initial migration; M0's `checkpoint_proof` fixture remains unrelated to product migrations. [Django custom-user guidance](https://docs.djangoproject.com/en/5.2/topics/auth/customizing/).

`UserManager` trims/lowercases email for case-insensitive identity, validates it, and converts international domains to ASCII IDNA. Non-ASCII local parts are not supported by this initial identity contract. `save` preserves canonical email; database uniqueness and canonical/ASCII constraints reject bypass writes. Duplicate display names are allowed; UUID is the identity. Display names are bounded and nonblank, and email is not automatically used as a public label.

`create_user` uses Django password hashing (or an unusable password when absent). `create_superuser` requires a usable password and framework staff/superuser flags. Inactive accounts are rejected by the framework backend. Workspace teaching roles and project access are separate policies; the user model has no global instructor/learner role. Email ownership verification, signup/login/logout/reset, session lifecycle/rate limits and admin UI remain M1.4. Manager tests do **not** establish a finished authentication feature.

Database/session cookies are host-only. Production session/CSRF cookies require HTTPS and use `__Host-` names; session cookies are HttpOnly. CSRF middleware remains enabled; runner origins are not trusted CSRF origins. New DRF views default to session authentication, authenticated access and JSON. Anonymous authentication endpoints will need explicit CSRF handling in M1.4; do not assume session authentication alone protects anonymous login requests.

Production settings are a scaffold, not deployment approval: TLS/host routing, verified database TLS, trusted proxy header stripping and HSTS policy require M1.2/M5 verification. No forwarded-header trust is enabled. HSTS is deliberately unset until the domain/proxy policy is reviewed; `check --deploy` therefore reports `security.W004`. Mail delivery is disabled in production and local-only in development/tests until M1.4 configures a real provider. No learner code executes in the API or ordinary job workers.

## Tests and type checks

```sh
export CODE_ALONG_POSTGRES_BIN="/absolute/path/to/postgresql-18/bin"
uv lock --check --offline
uv run --locked --offline ruff check .
uv run --locked --offline ruff format --check .
uv run --locked --offline mypy
DJANGO_SETTINGS_MODULE=config.settings.test uv run --locked --offline python -m pytest -q
```

The explicit test settings selector also overrides any development settings exported earlier. The Python suite has **97 tests**: the prior 29 M0 tests plus 68 backend cases. Native PostgreSQL 18 and the installed Node workspace are still required for the full suite's database/recovery cases. `-m 'not postgres'` is an explicit partial run, never a replacement for the integration gate. See [native prerequisites](postgres-tests.md).

Backend database tests start an owned private PG18 cluster, let pytest-django create/migrate a separate test database, and clean up both. Test settings ignore application credentials and initially point to a non-connectable socket. A separate lifecycle test applies the schema from scratch, checks UUID identity/no stock user table/no migration drift, reverses `accounts` to zero, then reapplies it. No existing database is migrated by these checks.

Startup tests validate development/production variants and secret failures in separate processes. HTTP tests prove liveness makes no DB query, unsafe methods/invalid hosts/CSRF remain rejected, and HTTP/unsupported WebSocket ASGI behavior is correct. An actual Daphne child adopts a parent-owned ephemeral loopback socket and is terminated/reaped after testing; it does not leave a running service or fixed port.

Mypy checks API source, tests, management entry point and test fixture in strict mode; generated migrations are checked through migration execution/drift tests instead. Only untyped calls into the upstream Channels router and asgiref test communicator are exempted; own code remains typed. JavaScript checks exclude the ignored `.uv-cache`, which now contains Django/Twisted vendor JavaScript; application source remains linted. No third-party code is edited to satisfy checks.

The full existing JavaScript/protocol and native collaboration suites remain separate regression gates. This backend-only unit does not change the runner/CodeMirror/browser code. PyPI advisory metadata was checked for all 45 exact third-party Python lock entries, with no known advisories reported at review time; that is not a guarantee that all vulnerabilities are known.

## Review record and file inventory

Verified on macOS arm64 with PostgreSQL 18.7; container/Linux and deployed TLS/proxy coverage belong to later gates. M1.1 verification passed in the development tree and an owned clean temporary workspace: locked offline uv/pnpm install, Ruff, strict API types, all 97 Python and 153 regular JavaScript cases, and 20 storage/13 transport native collaboration cases. The locks were unchanged by clean installation. The prior runner/browser runtime source is unchanged; its M0 results remain separate evidence rather than being counted as backend tests. The only production deployment-check warning was the expected HSTS follow-up, security.W004.

Proposed commit: `feat: add Django backend`. No commit/push/deployment has been performed for this unit. These files are new/updated relative to the approved M0 HEAD; the tracker also records the user's verified manual push.

- [AGENTS.md](../../AGENTS.md)
- [IMPLEMENTATION_PROGRESS.md](../../IMPLEMENTATION_PROGRESS.md)
- [README.md](../../README.md)
- [apps/api/.env.example](../../apps/api/.env.example)
- [apps/api/code_along/\_\_init\_\_.py](../../apps/api/code_along/__init__.py)
- [apps/api/code_along/accounts/\_\_init\_\_.py](../../apps/api/code_along/accounts/__init__.py)
- [apps/api/code_along/accounts/apps.py](../../apps/api/code_along/accounts/apps.py)
- [apps/api/code_along/accounts/managers.py](../../apps/api/code_along/accounts/managers.py)
- [apps/api/code_along/accounts/migrations/0001_initial.py](../../apps/api/code_along/accounts/migrations/0001_initial.py)
- [apps/api/code_along/accounts/migrations/\_\_init\_\_.py](../../apps/api/code_along/accounts/migrations/__init__.py)
- [apps/api/code_along/accounts/models.py](../../apps/api/code_along/accounts/models.py)
- [apps/api/code_along/accounts/tests/\_\_init\_\_.py](../../apps/api/code_along/accounts/tests/__init__.py)
- [apps/api/code_along/accounts/tests/test_users.py](../../apps/api/code_along/accounts/tests/test_users.py)
- [apps/api/config/\_\_init\_\_.py](../../apps/api/config/__init__.py)
- [apps/api/config/asgi.py](../../apps/api/config/asgi.py)
- [apps/api/config/environment.py](../../apps/api/config/environment.py)
- [apps/api/config/settings/\_\_init\_\_.py](../../apps/api/config/settings/__init__.py)
- [apps/api/config/settings/base.py](../../apps/api/config/settings/base.py)
- [apps/api/config/settings/development.py](../../apps/api/config/settings/development.py)
- [apps/api/config/settings/production.py](../../apps/api/config/settings/production.py)
- [apps/api/config/settings/test.py](../../apps/api/config/settings/test.py)
- [apps/api/config/tests/\_\_init\_\_.py](../../apps/api/config/tests/__init__.py)
- [apps/api/config/tests/test_environment.py](../../apps/api/config/tests/test_environment.py)
- [apps/api/config/tests/test_http.py](../../apps/api/config/tests/test_http.py)
- [apps/api/config/tests/test_migrations.py](../../apps/api/config/tests/test_migrations.py)
- [apps/api/config/tests/test_startup.py](../../apps/api/config/tests/test_startup.py)
- [apps/api/config/urls.py](../../apps/api/config/urls.py)
- [apps/api/config/views.py](../../apps/api/config/views.py)
- [apps/api/conftest.py](../../apps/api/conftest.py)
- [apps/api/manage.py](../../apps/api/manage.py)
- [apps/api/pyproject.toml](../../apps/api/pyproject.toml)
- [docs/operations/backend-development.md](backend-development.md)
- [eslint.config.mjs](../../eslint.config.mjs)
- [pyproject.toml](../../pyproject.toml)
- [uv.lock](../../uv.lock)

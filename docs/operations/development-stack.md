# Local development stack

This is development infrastructure, not a deployment configuration. Django owns migrations; learner Python never runs in its process. PostgreSQL data persists in the named Compose volume. Redis is transient. Only the HTTPS proxy is published, on loopback.

## Compose

Install a trusted Docker engine with Compose, Node/Corepack and the pinned Python/uv prerequisites from the README. From the repository root:

```sh
export UV_CACHE_DIR="$PWD/.uv-cache"
uv sync --locked --no-python-downloads
uv run --locked --offline python tools/dev/init_development.py
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml ps
curl --insecure --fail https://127.0.0.1:8443/health/ready/
```

Initialization creates private ignored `.env` credentials and `.runtime/certs/` self-signed certificates without overwriting existing credentials. Never commit either directory or print resolved Compose configuration into shared logs. The certificate is only for this local setup; `--insecure` is used only for its local smoke check. No system certificate/hosts changes are required. A browser may require accepting the local certificate before visiting the development app.

Open **https://127.0.0.1:8443**. The runner uses **https://localhost:8443**, a distinct site, with no product API route. Keep those hostnames distinct: cookies are host-only, and the runner cannot proxy account or project APIs. The proxy strips client forwarding headers and explicitly supplies HTTPS to Django. PostgreSQL and Redis have no host-published ports. HTTP liveness is `/health/live/`; readiness checks both DB and Redis and returns a generic 503 during failure.

```sh
# Stops this project's services; keeps the development database volume.
docker compose --env-file .env -f infra/compose.yaml stop
# Start again after code changes; builds are explicit, with no host source watcher.
docker compose --env-file .env -f infra/compose.yaml up --build -d
```

Images are pinned by digest in Compose/Dockerfiles: PostgreSQL 18.7, Redis 8.4.5, Python 3.13.12, Node 24.22.3 and Nginx 1.30.6. PostgreSQL 18 mounts `/var/lib/postgresql`, matching its versioned data layout. API image runs as UID 10001. Migrations complete before API startup; proxy waits for API readiness. Runner packaging verifies the pinned runtime inventory before copying assets. Dependency versions remain in uv/pnpm locks.

## Native fallback

An owned disposable native stack is available when a container engine is unavailable. It needs trusted PostgreSQL 18 tools, Redis 8, OpenSSL, installed JavaScript/Python workspaces and the built runner. Its database is **deleted on exit**; use Compose when you need persistent development data.

```sh
export COREPACK_HOME="$PWD/.pnpm-store/corepack"
export UV_CACHE_DIR="$PWD/.uv-cache"
export CODE_ALONG_POSTGRES_BIN=/absolute/path/to/postgresql-18/bin
export CODE_ALONG_REDIS_BIN=/absolute/path/to/redis-server
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @code-along/runner-web build
uv run --locked --offline python tools/dev/init_development.py
uv run --locked --offline python tools/dev/run_native.py
```

Foreground Ctrl-C stops only owned API/proxy/Redis/PostgreSQL processes. It binds HTTPS 8443 and an internal loopback API on 18000; do not run concurrently with Compose on the same ports. PostgreSQL and Redis use private Unix sockets with no TCP listener. Existing/reference databases and global services are never used. Native tooling is not installed by this script.

## Verification evidence

On 13 November 2026 the digest-pinned Compose stack built and ran in a project-owned Lima Linux VM with only this repository mounted read-only. DB/Redis/API became healthy, migration completed and proxy readiness returned 200. A probe row survived PostgreSQL restart; the probe table was removed. Stopping Redis changed readiness to 503; restarting it restored 200. The runner rejected `/api/` and unknown hosts received 421. The native fallback also returned readiness 200 and rejected product API access on its runner site. No shared database or existing VM was changed.

The VM is an optional local tool, not a repository prerequisite. On this workstation it lives under ignored `.runtime/lima/`, with SSH over loopback because vsock forwarding failed. An attempted project-owned Multipass VM was stopped after its private SSH route was unreachable. Neither workaround changes global firewall or trust settings. Production TLS/domain/mail/HSTS and operational hardening remain separate release/deployment work.

## Frontend and component library

The proxy now serves the React build from `apps/web/dist`. Rebuild containers after frontend changes. For quick UI-only iteration, `corepack pnpm --filter @code-along/web dev` starts Vite; authenticated integration uses the HTTPS proxy above, so no cross-origin credentials/CORS workaround is needed.

```sh
corepack pnpm --filter @code-along/web build
corepack pnpm --filter @code-along/design-system storybook
# Build the library before its local rendered/keyboard checks:
STORYBOOK_DISABLE_TELEMETRY=1 corepack pnpm --filter @code-along/design-system build-storybook
corepack pnpm --filter @code-along/browser-proofs test:foundation
```

Storybook serves on loopback 6006. Its build and the frontend build stay ignored. The design package uses strict source/stories checks with `skipLibCheck` limited to its third-party declaration files because Storybook 10.6.7 declarations conflict with TypeScript's exact optional properties; application source remains checked. The browser gate uses fresh owned Chromium/WebKit contexts, checks 320–1440px reflow, the skip link, routing, dialog focus trapping/Escape/return. Safari's macOS default link navigation uses Option-Tab, as documented by [Apple](https://support.apple.com/en-lamr/guide/safari/cpsh003/mac). This is automated keyboard/layout evidence, not a screen-reader audit or retail-browser certification.

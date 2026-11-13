# Local development stack

This is development infrastructure, not a deployment configuration. Django owns migrations; learner Python never runs in its process. PostgreSQL data persists in the named Compose volume. Redis is transient. Only the HTTPS proxy is published, on loopback.

## Normal local workflow

Install the pinned README prerequisites once, then run these commands from the repository root:

```sh
npm run dev
# Open https://127.0.0.1:8443 and keep this terminal open.
```

The foreground controller initializes missing ignored credentials/TLS without overwriting existing state, selects the existing project-owned Lima engine on this workstation (or a working Docker engine elsewhere), builds frozen dependencies/images, applies migrations and waits for DB/Redis/API readiness. The optional `infra/compose.development.yaml` profile adds a non-root React/Vite watcher on the private Docker network. App API requests go directly through the same HTTPS proxy to Django. Vite's port is not published to the host. Read-only frontend/shared-source mounts and polling support updates across the VM filesystem; backend and dependency changes need a restart/rebuild.

```sh
npm run status
npm run mail
npm run mail -- --latest
npm run stop
```

Status reads state without starting a stopped VM. Mail listing reports only whether messages exist; `--latest` explicitly prints the newest private message and its access link. Ctrl+C, SIGTERM, terminal SIGHUP or `npm run stop` shuts down this project's services while retaining database/mail volumes. The dedicated Lima VM is stopped too, releasing its 4 GiB allocation. Other Docker engines and unrelated VMs/services are left running. A per-project lock rejects duplicate controllers. Startup failures trigger cleanup, and repeated stops succeed when the VM is already stopped. A force-killed controller cannot run its Python cleanup; a later explicit `npm run stop` still controls the owned project without relying on stale PIDs.

The normal app origin remains **https://127.0.0.1:8443**, with isolated runner **https://localhost:8443**. System-wide certificate trust is **optional and deferred by the owner**. The current HTTPS profile can still show a warning; a site-specific exception, where supported by the browser, permits ordinary online use. The separate runtime may need its own exception; Run's connection-error help links to that page. Opening an HTTP URL does not switch this setup to HTTP, and no alternate HTTP profile has been implemented. M2 measures embedded isolation before enabling interactive input and provides batch input otherwise. Reliable offline script caching needs browser-accepted HTTPS. The [optional local HTTPS guide](local-https.md) describes the separate preparation, trust and validation commands. The readiness probe validates the configured certificate directly, rather than disabling TLS verification. No startup command installs certificate trust or changes global Docker contexts. An OS-trust failure from optional `tls:check` is expected while trust installation is deferred and does not imply the API/DB is unhealthy.

The existing base Compose profile below serves built/static assets for integration/packaging checks. Stop the foreground controller before switching manually between static and development profiles. The longer Lima commands are diagnostics; normal startup uses the npm scripts above.

## Try accounts and the M2 workbench

With `npm run dev` already running, open **https://127.0.0.1:8443**. If another terminal owns the foreground controller, the duplicate-start message is expected: open the existing app or use `npm run stop` followed by `npm run dev` to move the session to your terminal. Stopping preserves its accounts/projects/mail. A browser certificate exception may need accepting again after certificate replacement; system-wide CA installation remains optional.

1. Create an account using the signup screen.
2. Run `npm run mail -- --latest` in your own terminal, open the verification link and select **Verify email**. Sign in with the verified account.
3. Select **Create workspace**, enter a name and create it.
4. Select **Create project**, enter a name and open the project. Edit `main.py`, switch files and select **Run code**. Try input, captured-source inspection and Stop. Local source changes do not write a server Saved checkpoint; durable source persistence is M3.
5. To inspect sharing, use a second account in a separate browser profile, verify it through its own local message, then test workspace/project invitations and editor/viewer access. Workspace membership alone does not open private projects.
6. Select **Local drafts** to preview a template or import a `.codealong.json` source backup into a new local copy. The NumPy template uses an explicitly reviewed scientific profile. Local copies never change the original project.
7. Wait for **Local recovery updated** before reloading, and review the restore prompt on a server project's return. Source backups provide an independent export. Sign-out clears local drafts by default unless device retention is enabled. See [recovery](../protocols/local-recovery.md) and [project tools](../protocols/project-tools.md).

For offline practice, finish an online run and keep that complete workbench open before disconnecting. Each subsequent Run still has fresh Python state. Stop, navigation, missing/evicted scripts or a new runtime can require connectivity. Cold offline login is not provided. See [execution limits](../protocols/product-execution.md).

The product browser gate repeats account/workspace/invitation/permission flows and the M2 editor, execution, recovery, project-tool and offline scenarios in disposable PostgreSQL/Redis/browser fixtures. It does not create test accounts in the persistent development database. Its loopback test TLS settings do not prove normal-browser trust. The owner's manual walkthrough remains distinct from those automated results.

## Development proxy security and verification

The base application's static CSP and runner policy remain unchanged. The development app adds only its exact local WSS endpoint and a fresh inline-script nonce for React refresh. Vite emits a [nonce placeholder](https://vite.dev/config/shared-options.html#html-cspnonce); Nginx replaces it in HTML using its per-request random request ID and emits the matching policy. Source and reference: [Nginx sub_filter](https://nginx.org/en/docs/http/ngx_http_sub_module.html), [request_id](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_request_id), [Vite WebSocket proxy options](https://vite.dev/config/server-options.html#server-ws). The app still denies Workers and delegates its runner frame to the separate site. The runner never proxies product APIs. Browser console forwarding to the development terminal is disabled.

Development browser checks run against a disposable `code-along-ci`/`code-along-dev-check` project, with a test-only CSS fixture mount. They verify a different matching CSP nonce per HTML response, actual CSRF/API responses, runner API rejection, CSS hot updates without losing typed input, signup/private mail verification/login and workspace/project creation. The mail reader refuses primary/unknown projects, external origins, mismatched published ports and real recipients. Only fake `example.test` accounts are created. Local test credentials live in ignored `.runtime/dev-check.env`, separately from application credentials; CI generates its own `.env` on its disposable runner. No product source is edited by the hot-update test.

For an already running isolated test stack with all three Compose files applied:

```sh
CODE_ALONG_DEVELOPMENT_PROOF=true \
CODE_ALONG_DEVELOPMENT_PROJECT=code-along-dev-check \
CODE_ALONG_DEVELOPMENT_ORIGIN=https://127.0.0.1:18443 \
corepack pnpm --filter @code-along/browser-proofs test:development
```

The CI Compose job runs the base image smoke, switches to the watcher/test profile, runs Chromium/WebKit checks and removes only its disposable test project volumes. Account traces remain disabled. Root-controller unit tests exercise port/input validation, engine ownership, locks, startup/readiness failures, terminal signals, repeated shutdown, and explicit mail access. Live start/stop/restart verification also checks the primary database identity/counts and unchanged environment fingerprint.

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

Initialization creates private ignored `.env` credentials and, if no certificate exists, `.runtime/certs/` self-signed certificates. It preserves an existing mkcert certificate. Never commit credential/certificate directories or print resolved Compose configuration into shared logs. `--insecure` above is only for the isolated self-signed smoke check. The [local HTTPS trust workflow](local-https.md) is an optional way to remove browser warnings; the owner has deferred its system trust step. It needs no hosts-file changes.

Open **https://127.0.0.1:8443**. The runner uses **https://localhost:8443**, a distinct site, with no product API route. Keep those hostnames distinct: cookies are host-only, and the runner cannot proxy account or project APIs. The proxy strips client forwarding headers and explicitly supplies HTTPS to Django. PostgreSQL and Redis have no host-published ports. HTTP liveness is `/health/live/`; readiness checks both DB and Redis and returns a generic 503 during failure.

```sh
# Stops this project's services; keeps the development database volume.
docker compose --env-file .env -f infra/compose.yaml stop
# Start again after code changes; builds are explicit, with no host source watcher.
docker compose --env-file .env -f infra/compose.yaml up --build -d
```

Images are pinned by digest in Compose/Dockerfiles: PostgreSQL 18.7, Redis 8.4.5, Python 3.13.12, Node 24.22.3 and Nginx 1.30.6. PostgreSQL 18 mounts `/var/lib/postgresql`, matching its versioned data layout. API image runs as UID 10001. Migrations complete before API startup; proxy waits for API readiness. Runner packaging verifies the pinned runtime inventory before copying assets. Dependency versions remain in uv/pnpm locks.

## This workstation: owned Lima engine

The host has no working Docker engine/CLI. The already provisioned `code-along` Lima VM supplies it. From `/Users/dibyajyoti/Desktop/Projects/Code-Along`:

```sh
# Start the existing owned VM if it is stopped.
LIMA_HOME="$PWD/.runtime/lima" .runtime/tools/lima/bin/limactl start code-along
# Build/start only Code Along, preserving its database and private mail volumes.
LIMA_HOME="$PWD/.runtime/lima" .runtime/tools/lima/bin/limactl shell code-along sh -c \
  'cd /Users/dibyajyoti/Desktop/Projects/Code-Along && docker compose --env-file .env -f infra/compose.yaml up --build -d'
LIMA_HOME="$PWD/.runtime/lima" .runtime/tools/lima/bin/limactl shell code-along sh -c \
  'cd /Users/dibyajyoti/Desktop/Projects/Code-Along && docker compose --env-file .env -f infra/compose.yaml ps'
uv run --locked --offline python tools/ci/compose_smoke.py
```

The final M1 build and host-side smoke check passed at **https://127.0.0.1:8443**. The VM has only this repository mounted read-only; its containers own the persistent named volumes. It does not mount the user's home or reference repository. It uses loopback SSH because initial vsock forwarding failed. The attempted empty Multipass fallback VM was removed after its private SSH route proved unreachable; no existing VM, global firewall or trust settings were changed.

To stop the application while keeping data:

```sh
LIMA_HOME="$PWD/.runtime/lima" .runtime/tools/lima/bin/limactl shell code-along sh -c \
  'cd /Users/dibyajyoti/Desktop/Projects/Code-Along && docker compose --env-file .env -f infra/compose.yaml stop'
```

Do not use `down --volumes` on this development stack if you want to retain accounts/projects. For email, run the commands in the [account guide](authentication.md) inside this VM; they are not host Docker commands. The VM/tool downloads live under ignored `.runtime/` and are machine-local setup, not requirements for another developer with a trusted Docker engine.

## Native fallback

An owned disposable native stack is available when a container engine is unavailable. It needs trusted PostgreSQL 18 tools, Redis 8, OpenSSL, installed JavaScript/Python workspaces and the built runner. Its database is **deleted on exit**; use Compose when you need persistent development data.

```sh
export COREPACK_HOME="$PWD/.pnpm-store/corepack"
export UV_CACHE_DIR="$PWD/.uv-cache"
export CODE_ALONG_POSTGRES_BIN=/absolute/path/to/postgresql-18/bin
export CODE_ALONG_REDIS_BIN=/absolute/path/to/redis-server
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @code-along/web build
corepack pnpm --filter @code-along/runner-web build
uv run --locked --offline python tools/dev/init_development.py
uv run --locked --offline python tools/dev/run_native.py
```

Foreground Ctrl-C stops only owned API/proxy/Redis/PostgreSQL processes. It binds HTTPS 8443 and an internal loopback API on 18000; do not run concurrently with Compose on the same ports. PostgreSQL and Redis use private Unix sockets with no TCP listener. Existing/reference databases and global services are never used. Native tooling is not installed by this script.

## Verification evidence

On 13 November 2026 the digest-pinned Compose stack built and ran in a project-owned Lima Linux VM with only this repository mounted read-only. DB/Redis/API became healthy, migration completed and proxy readiness returned 200. A probe row survived PostgreSQL restart; the probe table was removed. Stopping Redis changed readiness to 503; restarting it restored 200. The runner rejected `/api/` and unknown hosts received 421. The native fallback also returned readiness 200 and rejected product API access on its runner site. No shared database or existing VM was changed.

The final M1 rebuild also passed migrations, app/DB/Redis health, React assets, host-only CSRF cookie/no-store, runner API rejection, unknown-host rejection, Worker CSP and the shipped WASM hash/MIME check. Production TLS/domain/mail/HSTS and operational hardening remain separate release/deployment work. CI builds a separate `code-along-ci` stack and removes only its disposable volumes; the local `code-along-dev` data is preserved.

The M2 rebuild through `npm run dev` passed those smoke checks again, plus explicit project-CA HTTPS validation, actual cache-capable runner shell/Worker delivery and rendered Chromium/WebKit login/reflow without page errors. The PostgreSQL system identity, user/workspace/project/runtime-profile counts and five environment/certificate/CA fingerprints match the pre-test baseline. No primary account was created for these checks. See the [M2 validation report](../architecture/m2-validation.md).

## Frontend and component library

Use root `npm run dev` for connected frontend iteration with live updates. The base Compose profile serves the React build from `apps/web/dist` and requires rebuilding after frontend changes. A standalone `corepack pnpm --filter @code-along/web dev` preview does not start the backend; use the root command for account/project flows. Storybook remains a separate component workspace.

```sh
corepack pnpm --filter @code-along/web build
corepack pnpm --filter @code-along/design-system storybook
# Build the library before its local rendered/keyboard checks:
STORYBOOK_DISABLE_TELEMETRY=1 corepack pnpm --filter @code-along/design-system build-storybook
corepack pnpm --filter @code-along/browser-proofs test:foundation
```

Storybook serves on loopback 6006. Its build and the frontend build stay ignored. The design package uses strict source/stories checks with `skipLibCheck` limited to its third-party declaration files because Storybook 10.6.7 declarations conflict with TypeScript's exact optional properties; application source remains checked. The browser gate uses fresh owned Chromium/WebKit contexts, checks 320–1440px reflow, the skip link, routing, dialog focus trapping/Escape/return. Safari's macOS default link navigation uses Option-Tab, as documented by [Apple](https://support.apple.com/en-lamr/guide/safari/cpsh003/mac). This is automated keyboard/layout evidence, not a screen-reader audit or retail-browser certification.

## M3 collaboration service setup

The normal controller now starts the private Node/Hocuspocus service alongside Django. `npm run dev` adds missing collaboration credentials to the ignored `.env` atomically, preserving existing values. It does not rotate the application secret/database password or alter the local CA/trust decision. Migration and dedicated-role provisioning complete before the collaboration service starts. Only the HTTPS proxy is published on loopback; private authorization/control routes are denied there.

The service uses a separate `code_along_collaboration` database account, an explicit development-only non-TLS private database connection, bounded queues/connections, a 256 MiB JavaScript heap and a 512 MiB container ceiling. The product schema remains Django-owned. Never substitute the API/database-owner credentials for the collaboration role. Development containers use local settings; these private connection settings are not production deployment instructions.

Run the product persistence integration gate separately from the M0 proofs:

```sh
uv run --locked --offline python tools/dev/postgres_cluster.py -- corepack pnpm --filter @code-along/collaboration test:product
```

It requires the documented owned PostgreSQL 18 tools and installed Python/Node workspaces, creates actual Django migrations and a restricted test role, and cleans up its disposable cluster. It does not use the persistent app database. The full CI source path includes this gate. See [product collaboration](../protocols/product-collaboration.md) for ticket, lease, binary initialization and receipt semantics. M3's integrated editor/history/chat and final restart/browser gates are tracked separately until verified.

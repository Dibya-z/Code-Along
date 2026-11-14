# Production preparation

This is the single-host MVP deployment profile for the existing Django, Node,
Nginx, Redis and browser-Python architecture. It is separate from local
development. No production deployment has been performed. Current acceptance
and remaining blockers are in [MVP readiness](mvp-readiness.md).

## Required inputs

- A Linux host with Docker Compose and enough measured memory/storage for the
  configured services and builds. Keep only one collaboration writer running.
- PostgreSQL 18 with a dedicated database, a hostname-valid TLS certificate and
  its CA file. The migration/provisioning role needs schema and `CREATE ROLE`
  privileges; Node receives the separately provisioned restricted writer role.
  Confirm these privileges with the database provider before selecting it.
- Two HTTPS sites with valid certificates: for example `learn.example.com` and
  `python.example.net`. App/runner subdomains under one registrable site are
  rejected. The conservative validator requires different final two hostname
  labels; it deliberately rejects some otherwise valid public-suffix layouts.
- An authenticated STARTTLS SMTP service, verified sender and functioning
  delivery. Registration, verification and password reset require real mail.
- Independent production secrets, private backups and explicit deployment
  approval. Never reuse development secrets or the local development CA.

Copy [the placeholder template](../../.env.production.example) into a private
file outside the repository/build context, such as
`/etc/code-along/production.env`, readable only by its operator. Set every value.
Each TLS directory contains `fullchain.pem` and private `privkey.pem`; the
PostgreSQL CA is mounted separately. That public CA file must be readable by
API UID 10001 and Node UID 1000; keep proxy private keys restricted. Preserve
the supplied file permissions.
The profile rejects missing inputs; it never creates production credentials,
certificates or DNS records. Do not print resolved Compose configuration or
environment variables into shared logs.

## Review and build

These are operator instructions, not permission to start a deployment. Run from
the reviewed repository checkout on the target host:

```sh
docker compose --env-file /etc/code-along/production.env -f infra/compose.production.yaml config --quiet
docker compose --env-file /etc/code-along/production.env -f infra/compose.production.yaml build api collaboration proxy
docker compose --env-file /etc/code-along/production.env -f infra/compose.production.yaml run --rm --no-deps api /app/.venv/bin/python manage.py check --deploy --fail-level ERROR
```

Use an immutable reviewed release identifier in `CODE_ALONG_RELEASE`. The API
image is shared by migrations, role provisioning, API and notification jobs;
the frontend is a static build, with no development watcher. Builds require
registry access for uncached pinned images/packages. Dependencies remain locked;
application source edits can reuse the frontend dependency installation layer.

The production check intentionally reports `security.W005` and `security.W021`:
HSTS starts at one hour without `includeSubDomains` or preload. Do not describe
that as zero warnings. Review wider HSTS policy only after the owner validates
the actual domain/certificate coverage. This follows Django's
[deployment checklist](https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/).

## Controlled startup after approval

Back up an existing database and stop/drain the previous writer before changing
releases. Then, only after explicit deployment approval:

```sh
docker compose --env-file /etc/code-along/production.env -f infra/compose.production.yaml up -d
docker compose --env-file /etc/code-along/production.env -f infra/compose.production.yaml ps
```

Migration and restricted-role provisioning are ordered one-shot services.
Readiness requires PostgreSQL and Redis; the proxy waits for API and
collaboration readiness. Only the proxy publishes ports 80/443. Redis has an
[internal network](https://docs.docker.com/reference/compose-file/networks/#internal),
no published port and bounded memory. Trusted API/Node services have outbound
connectivity for the managed database and mail. Container filesystems are
read-only with bounded temporary mounts.

The proxy rejects unknown hosts, overwrites forwarded headers and blocks public
`/internal/` access. Django trusts only this private proxy topology. Exact
health and bearer-authenticated internal admission paths are exempt from HTTP
redirection so Node can reach them privately; public APIs still require HTTPS.
The runner serves no account API, receives no app cookie, and retains its
Worker CSP and cross-origin-isolation headers. Python runs only in that browser
Worker, never in Django, Node or the notification worker.

Before inviting users, verify both public certificate chains, HTTPS redirects,
app/runner headers, registration/verification/reset mail, two-user editing,
receipt-based Saved, Python output/Stop, and a teacher/learner submission and
feedback flow. Verify that source/private artifacts remain denied to unrelated
accounts. Internal container health checks do not establish public TLS trust,
mail delivery or a successful end-to-end release.

## Backup and recovery

Use Python 3.13 and a trusted PostgreSQL 18 client directory, with explicit `PGHOST`, `PGPORT`,
`PGDATABASE`, `PGUSER`, plus private `PGPASSFILE` or `PGPASSWORD` credentials.
Use one hostname/IP or one absolute Unix socket directory; host lists are
rejected. For TCP, set `PGSSLMODE=verify-full` and `PGSSLROOTCERT` to the database
CA. The backup tool forces `PGGSSENCMODE=disable`; use that setting for manual
restore commands too, so libpq uses the configured TLS verification policy. See
[PostgreSQL connection modes](https://www.postgresql.org/docs/18/libpq-connect.html).
Supply credentials through the operator's protected environment; do not put a
connection URL/password in command arguments or shell history.

```sh
python -m tools.ops.postgres_backup --pg-bin /path/to/postgresql-18/bin backup --output /private/backups/NEW-release-directory
python -m tools.ops.postgres_backup --pg-bin /path/to/postgresql-18/bin verify /private/backups/NEW-release-directory
```

The destination must be new. The tool creates a private custom archive and
checksum manifest, refuses overwrite, uses bounded read-only database access,
and does not print SQL or credentials. Failed runs may leave private partial
output for inspection. `verify` checks bytes and PostgreSQL's archive catalog;
it does **not** prove restoration or authenticate an attacker-replaced manifest.
Backups contain private source, account/session data, submissions and feedback.
Keep them out of Git and encrypt off-host copies using the operator's existing
backup system. Retention deletion is an explicit operator action.

For a recovery drill, first create a separate **empty** target database and
point the protected `PG*` environment at that target. `PGDATABASE` must contain
only its database name, never a connection URL. Preserve the source
database and backup. After independently verifying the target identity:

```sh
/path/to/postgresql-18/bin/pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-acl --dbname "$PGDATABASE" /private/backups/REVIEWED-directory/database.dump
```

Do not add `--clean` or restore over a live database. Validate actual project
bytes, private submissions and published feedback, then provision the restricted
collaboration role before connecting a writer. The tool intentionally provides
no general restore/delete command. A managed provider's snapshot/PITR service
is additional protection; provider restore behavior requires its own drill.

For a planned restart, ask active users to wait for **Saved**, then stop the
existing collaboration/API/jobs/scheduler before replacing the release. Allow
the configured shutdown grace period and confirm the old writer exited before
starting another. A backup captures committed database state, not unsaved editor
buffers or a browser-only recovery copy. Restore into a new database after a
bad migration; do not blindly reverse migrations that protect private artifacts.

Use `/health/live/`, `/health/ready/` and bounded service logs for the MVP's
operational checks. Do not upload environment dumps, raw learner code, database
dumps or token-bearing URLs. High availability, fleet orchestration and broader
observability remain later work, rather than implied capabilities of this profile.

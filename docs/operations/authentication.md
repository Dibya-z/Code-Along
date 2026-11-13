# Accounts and sessions

Code Along uses Django/allauth headless with only the browser client enabled. There is no browser JWT or localStorage session token. Product APIs require an active user with a verified primary email. UUID/email/display name remain in `accounts.User`; verification belongs to allauth's `EmailAddress`.

The React forms implement signup, sign-in, explicit email confirmation, logout and password reset. Confirmation is a POST after the user opens the email link; a mail scanner's GET cannot confirm an account. Verification links expire after one day; password reset links after 30 minutes. Reset success does not automatically sign in, reusing a reset key fails, and a password change invalidates older sessions. Sessions last at most 12 hours and use browser-session cookies. Production cookies are host-only, Secure and HttpOnly with SameSite=Lax; CSRF uses its separate host-only cookie/masked bootstrap token.

## Routes and policy

- `GET /api/v1/csrf/`: masked token, no-store.
- `GET /api/v1/me/`: own verified identity only.
- `/api/v1/auth/browser/v1/auth/signup`, `login`, `session` (GET/DELETE), `email/verify`, `password/request`, `password/reset`: allauth's browser protocol. A 401 without errors can mean pending email verification or successful logout; it is not an authenticated product session.
- Frontend `/login`, `/auth/signup`, `/auth/verify?key=…`, `/auth/forgot`, `/auth/reset?key=…`.

All API responses use no-store and vary by Cookie. Unsafe requests require CSRF and a matching Origin. The isolated runner is not a CSRF-trusted origin and has no product API proxy. Account changes clear the client query cache and reload with the new session; cached data is never reused between accounts. Private mail tokens are removed from the page URL after use. No request/source payloads are logged by local proxies; product browser tests deliberately disable traces that could contain credentials.

Allauth's default login/signup/reset/password-change limits use the configured shared Redis cache, including limits by IP, user or normalized email as applicable. Separate browser sessions share these limits. Proxy trust is explicit: Compose strips incoming forwarding headers and supplies one client IP; native fallback does the same. Never expose a trusted-proxy API port directly to untrusted networks. Redis failures fail closed; readiness also reports unavailable. Test settings use a cleared local cache, never a shared deployment cache.

## Development email

Compose writes messages to its private `mail` volume at `/app/dev-mail`, owned by the API user. It does not send mail externally. After registering, list messages with:

```sh
docker compose --env-file .env -f infra/compose.yaml exec api ls /app/dev-mail
# Read the chosen message privately, replacing MESSAGE with its filename:
docker compose --env-file .env -f infra/compose.yaml exec api cat /app/dev-mail/MESSAGE
```

Open its verification/reset link in the same development application. Native fallback writes to ignored `.runtime/mail/`; read the chosen `.log` file locally. These messages contain account-access links: keep them private and never paste them into shared logs or Git. The test suite uses unique fake `example.test` recipients and reads only its private mail store. File delivery is development-only.

## Production configuration

Before enabling real accounts, explicitly configure `CODE_ALONG_APP_ORIGIN` (exact HTTPS origin), `CODE_ALONG_SMTP_HOST`, `CODE_ALONG_SMTP_PORT`, `CODE_ALONG_SMTP_USER`, `CODE_ALONG_SMTP_PASSWORD` and `CODE_ALONG_FROM_EMAIL`. SMTP uses STARTTLS and a 10-second timeout. Mail sending fails if origin/host/sender are missing; no credentials or external sender are supplied by this repository. Production mail delivery, domain/TLS/HSTS policy and deployment require separate operational review and approval.

The standard backend suite tests account/profile validation, verification, duplicate-signup non-disclosure, inactive/unverified users, session rotation/expiry/logout, reset non-disclosure/expiry/reuse/other-session invalidation, CSRF/Origin checks and limits across independent sessions. The real product browser gate also exercises local email links in Chromium and WebKit:

```sh
# Set CODE_ALONG_POSTGRES_BIN and CODE_ALONG_REDIS_BIN first; install/build prerequisites.
corepack pnpm --filter @code-along/web build
corepack pnpm --filter @code-along/browser-proofs test:product
```

It owns disposable services on HTTPS 18443/API 18001, stops them afterward, and does not migrate the Compose/reference database. Social sign-in and MFA are not enabled in M1.

Product APIs also use a shared per-identity 120-request/minute coarse budget. Anonymous CSRF bootstrap uses the caller IP. Forwarded IP trust is explicit and matches the owned proxy policy; no raw client forwarding header is trusted when proxy trust is disabled. Framework cache throttles are abuse controls, not atomic execution quotas or measured capacity guarantees.

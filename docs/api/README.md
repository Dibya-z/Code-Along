# API contracts

`openapi.json` describes the Code Along product API. `auth-openapi.json` is generated from the installed allauth browser-only configuration, including the custom display-name signup field. API clients must still satisfy server-side session, CSRF, membership and project policies; a TypeScript type is never authorization.

Generate and check from the repository root, with the documented local Corepack/uv caches and locked dependencies installed:

```sh
corepack pnpm api:generate
corepack pnpm api:check
```

Generation uses isolated `config.settings.schema`: the DB is non-connectable and external services/mail are not configured. It never reads a live database. Product schemas derive from actual request serializers and explicitly declared public response projections, using [drf-spectacular](https://drf-spectacular.readthedocs.io/en/latest/). Warnings fail generation. Partial-update defaults are disabled because these APIViews require explicit metadata versions rather than DRF's automatic partial serializers. File deletion sends `expected_version` as a required query parameter; other file/metadata writes use the required JSON field.

[allauth's headless specification](https://docs.allauth.org/en/latest/headless/openapi-specification/) is generated separately to preserve its upstream schema/license and browser protocol. Only two random documentation UUID example locations are normalized for deterministic output; no validation or response behavior is changed. The headless specification routes are enabled only in offline schema settings, not in development/production runtime. See [third-party notice](THIRD_PARTY_NOTICES.md).

`packages/api-client` uses [openapi-typescript/openapi-fetch](https://openapi-ts.dev/openapi-fetch/) to expose generated paths, bodies, results and typed client factories. Frontend identity/workspace/project reads and core creation calls use typed operations; feature response types derive from the generated schemas. The shared credential transport handles same-origin credentials, one concurrent CSRF bootstrap, generic non-JSON failures and cancellation, and is also used by controlled metadata mutation adapters and the allauth flow adapter. No browser JWT/session token is persisted.

The code-generation CLI alone has TypeScript 5.9.3 to satisfy its declared TypeScript-5 peer. Root/application/design/client-source checks explicitly remain on TypeScript 6.0.3. This avoids weakening strict peers or changing the approved application toolchain. Generated schema/TypeScript files are intentionally versioned; builds, mail, keys and caches remain ignored. Prettier is part of generation so drift checks compare stable output.

Tests check offline generation against snapshots, browser-only auth/profile fields, authentication declarations, required metadata versions, actual endpoint response projections and the DELETE precondition. Existing permission/CSRF/tenant/role tests remain authoritative. CI regenerates both schemas and declarations and rejects drift. Auth flows' 401 can indicate a pending verification stage or successful logout; inspect their documented meta/flow state instead of treating it as a product session.

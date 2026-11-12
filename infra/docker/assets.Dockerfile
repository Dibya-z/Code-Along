FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner-web ./apps/runner-web
COPY apps/collaboration/package.json ./apps/collaboration/package.json
COPY tests/browser/package.json ./tests/browser/package.json
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @code-along/runner-web build
COPY tools/dev/copy_runtime.mjs ./tools/dev/copy_runtime.mjs
RUN node tools/dev/copy_runtime.mjs
FROM nginx:1.30.6-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311
COPY --from=build /app/apps/runner-web/dist /srv/runner
COPY infra/proxy/static /srv/web
COPY infra/proxy/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/proxy/start.sh /docker-entrypoint.d/19-runner-origin.sh
RUN chmod +x /docker-entrypoint.d/19-runner-origin.sh

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/runner-web ./apps/runner-web
COPY apps/web ./apps/web
COPY apps/collaboration/package.json ./apps/collaboration/package.json
COPY tests/browser/package.json ./tests/browser/package.json
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @code-along/runner-web build
RUN corepack pnpm --filter @code-along/web build
COPY tools/dev/copy_runtime.mjs ./tools/dev/copy_runtime.mjs
RUN node tools/dev/copy_runtime.mjs
FROM build AS development
RUN mkdir -p /app/apps/web/node_modules/.vite /app/apps/web/node_modules/.vite-temp /app/node_modules/.vite-temp && chown -R node:node /app/apps/web/node_modules/.vite /app/apps/web/node_modules/.vite-temp /app/node_modules/.vite-temp
USER node
WORKDIR /app/apps/web
CMD ["corepack", "pnpm", "exec", "vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
FROM nginx:1.30.6-alpine@sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311
COPY --from=build /app/apps/runner-web/dist /srv/runner
COPY --from=build /app/apps/web/dist /srv/web
COPY infra/proxy/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/proxy/app-static-csp.conf.template /etc/nginx/templates/app/csp.conf.template
COPY infra/proxy/app-static-content.conf.template /etc/nginx/templates/app/content.conf.template
COPY infra/proxy/start.sh /docker-entrypoint.d/19-runner-origin.sh
RUN chmod +x /docker-entrypoint.d/19-runner-origin.sh

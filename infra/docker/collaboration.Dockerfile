FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
ENV COREPACK_HOME=/opt/corepack NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts ./packages/contracts
COPY apps/collaboration ./apps/collaboration
COPY apps/web/package.json ./apps/web/package.json
COPY apps/runner-web/package.json ./apps/runner-web/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/design-system/package.json ./packages/design-system/package.json
COPY tests/browser/package.json ./tests/browser/package.json
RUN corepack pnpm --filter @code-along/collaboration... install --prod --frozen-lockfile
USER node
CMD ["node", "apps/collaboration/src/main.ts"]

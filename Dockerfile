FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mcp-server/package.json apps/mcp-server/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/gmail-adapter/package.json packages/gmail-adapter/package.json
COPY packages/microsoft-adapter/package.json packages/microsoft-adapter/package.json
COPY packages/oauth/package.json packages/oauth/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/zoho-adapter/package.json packages/zoho-adapter/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm -r build
RUN pnpm deploy --legacy --filter @yempik/mcp-server --prod /release

FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-http-header-size=65536
WORKDIR /app
COPY --from=build --chown=node:node /release ./
COPY --from=build --chown=node:node /workspace/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]

# Cairn server + console. Multi-stage, no build tools needed at runtime.
FROM oven/bun:1 AS build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/executor/package.json packages/executor/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile \
  && bunx tsc -b packages/core packages/ai packages/executor apps/server \
  && cd apps/web && bunx vite build

FROM oven/bun:1-slim
LABEL org.opencontainers.image.title="Cairn" \
      org.opencontainers.image.description="Evidence-first automation and QA" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/packages ./packages
COPY --from=build /build/apps/server/dist ./apps/server/dist
COPY --from=build /build/apps/server/package.json ./apps/server/
COPY --from=build /build/apps/web/dist ./apps/web/dist
COPY --from=build /build/apps/server/src ./apps/server/src

ENV CAIRN_HOST=0.0.0.0 \
    CAIRN_PORT=5175 \
    CAIRN_DATA_DIR=/data
VOLUME /data
EXPOSE 5175

# Health check hits the real API — a server that serves 200s but is broken fails here.
HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD curl -sf http://127.0.0.1:5175/api/health || exit 1

CMD ["sh", "-c", "cd /app/apps/server && exec node dist/index.js"]

FROM oven/bun:1.4.3 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS builder
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 nail \
    && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin nail
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=builder --chown=10001:10001 /app/public ./public
COPY scripts/docker-entrypoint.sh /usr/local/bin/nail-entrypoint
RUN chmod 0555 /usr/local/bin/nail-entrypoint \
    && mkdir -p /app/.next/cache \
    && chown 10001:10001 /app/.next/cache
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/nail-entrypoint"]
CMD ["node", "server.js"]

FROM oven/bun:1.4.3 AS connector-builder
WORKDIR /build
COPY worker/providers ./worker/providers
COPY lib/domain/subscription-provider.ts ./lib/domain/subscription-provider.ts
COPY lib/server/providers/subscription-errors.ts ./lib/server/providers/subscription-errors.ts
RUN mkdir -p /out \
    && bun build --compile --target=bun-linux-x64 --outfile=/out/nail-connector ./worker/providers/connector-daemon.ts

FROM node:24-bookworm-slim AS connector
ENV NODE_ENV=production
WORKDIR /opt/nail-connector
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 nail \
    && useradd --system --uid 10001 --gid 10001 --home-dir /tmp --no-create-home --shell /usr/sbin/nologin nail \
    && mkdir -p /opt/nail-connector /opt/vendor-bin \
    && chown 10001:10001 /opt/nail-connector
COPY --from=connector-builder --chown=10001:10001 /out/nail-connector /usr/local/bin/nail-connector
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/nail-connector"]

# syntax=docker/dockerfile:1

# ---- base ----
FROM node:24-bookworm-slim AS base
RUN apt-get update -y && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# ---- dev ----
FROM deps AS dev
ENV NODE_ENV=development
COPY docker/dev-entrypoint.sh /usr/local/bin/dev-entrypoint
RUN chmod +x /usr/local/bin/dev-entrypoint && chown -R node:node /app
USER node
ENTRYPOINT ["/usr/local/bin/dev-entrypoint"]
CMD ["npx", "nest", "start", "--watch", "--preserveWatchOutput"]


# ---- builder ----
FROM deps AS builder
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
COPY . .
RUN npx prisma generate && npm run build \
    && mkdir -p dist/generated \
    && cp -r src/generated/prisma dist/generated/


# ---- runtime, what's shipped ----
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist          ./dist
COPY --from=builder --chown=node:node /app/prisma        ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/package.json ./package.json

EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]

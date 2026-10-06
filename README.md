# cstam backend

REST API, WebSocket gateways and queue worker of the gaming-cafe platform: accounts, bookings, PIN check-in, sessions, billing, wallet and station (PC) management.

* NestJS 12 on Fastify 5, TypeScript
* Prisma 7 on Postgres 16
* Redis 7 and BullMQ 6 (command queue, presence and telemetry cache)
* Caddy 2 (TLS reverse proxy)
* Node 22.23+ (the Docker image uses Node 24)

API reference: see [docs/SWAGGER.md](docs/SWAGGER.md).

## Run it (Docker, recommended)

Prerequisites: Docker with Compose v2, Node and npm (only to launch the `npm run` shortcuts).

### First time

```bash
npm install                # installs the CLI tools used by the scripts
cp .env.example .env       # then edit the values (see "Environment")
npm run docker:dev         # build + migrate + start; the first build is slow
```

Wait until the `reverse-proxy` container starts: it starts last, so all earlier steps worked. Then, in another terminal:

```bash
npm run db:seed            # optional: demo data (see "Seed data")
curl -s localhost:3000/health
```

Open <http://localhost:3000/docs> for the Swagger UI.

### Every later run

```bash
npm run docker:up          # start
npm run docker:down        # stop; the database and Redis data stay
```

### What starts

| service | image | role |
|:---|:---|:---|
| `postgres` | postgres:16-alpine | database (volume `pgdata`) |
| `redis` | redis:7-alpine | BullMQ broker, append-only file (volume `redisdata`) |
| `migrate` | cstam-backend | runs `prisma migrate deploy` once, then exits |
| `backend` | cstam-backend | REST API, Swagger, WebSocket gateways, queue worker, port 3000 |
| `reverse-proxy` | caddy:2-alpine | TLS on `:443` (internal CA) in front of the backend |

Boot order: `postgres` and `redis` become healthy, `migrate` applies the migrations and exits, `backend` starts, then `reverse-proxy` starts once `backend` is healthy.

In dev (`docker-compose.dev.yml` is layered on top by every `npm run docker:*` script) the backend runs in watch mode on the bind-mounted source, and these ports are published on the host:

| port | what |
|:---|:---|
| 3000 | the backend directly (bypasses Caddy) |
| 443 / 80 | Caddy (80 redirects to 443) |
| 5432 | Postgres |
| 6379 | Redis |
| 9229 | Node inspector |

Through Caddy: `curl -sk https://localhost/health`. The hostname `cstam-server.local` also works if you map it to `127.0.0.1` in your hosts file. Edit the `Caddyfile` to add other names or IPs.

> [!NOTE]
> Inside a container, `localhost` means that container. In `.env`, refer to other services by name: `postgres:5432`, `redis:6379`, `backend:3000`.

## Environment

`.env.example` is the template. Required:

| variable | meaning |
|:---|:---|
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | database credentials |
| `DATABASE_URL` | e.g. `postgresql://cstam:change-me@postgres:5432/cstam?schema=public` |
| `REDIS_URL` | e.g. `redis://redis:6379` |
| `PORT`, `NODE_ENV` | `3000`, `development` or `production` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | signing secrets. The access secret also signs station tokens. Change both |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `JWT_ISSUER` | `15m`, `30d`, `cstam-identity` |

Optional (defaults shown):

| variable | default | meaning |
|:---|:---|:---|
| `BUSINESS_TIMEZONE` | `Africa/Tunis` | time zone for pass time windows |
| `SESSION_MIN_PLAY_MINUTES` | 5 | a login needs balance for this many minutes of play |
| `NO_SHOW_GRACE_MINUTES` | 30 | a booking not logged into this long after its start becomes NO_SHOW; also the PIN deadline |
| `SESSION_PIN_MAX_ATTEMPTS` | 5 | wrong PINs before the PIN is burned |
| `SESSION_RUNOUT_MARGIN_S` | 30 | the station locks this long before the money runs out |
| `SESSION_RUNOUT_WARNING_LEAD_S` | 300 | low-balance warning comes this long before the lock |
| `SESSION_ENDING_NOTICE_MINUTES` | 10 | "time left" notice comes this long before the end |
| `SESSION_LEASE_CAP_S` | 180 | longest lease per heartbeat ack |
| `PIN_ENCRYPTION_KEY` | derived from `JWT_ACCESS_SECRET` | seals the PIN so it can be shown again (16+ characters) |
| `RATE_LIMIT_LOGIN_FAILURES` | 10 | wrong passwords per IP + username in 15 minutes, then 429 |
| `RATE_LIMIT_REFRESHES_PER_MINUTE` | 60 | `POST /auth/refresh` per IP |
| `RATE_LIMIT_SIGNUPS_PER_HOUR` | 30 | `POST /users` per IP |
| `PRESENCE_OFFLINE_AFTER_MS` | 45000 | heartbeat silence before a station is OFFLINE |
| `PRESENCE_WATCHDOG_INTERVAL_MS` | 10000 | watchdog sweep period |
| `PRESENCE_PERSIST_INTERVAL_MS` | 15000 | max `last_seen` write rate to Postgres |
| `COMMAND_ACK_TIMEOUT_MS` | 10000 | wait for a station ack (max 25000) |
| `COMMAND_MAX_ATTEMPTS` | 2 | sends per command (1 to 5) |
| `COMMAND_RETRY_BACKOFF_MS` | 1000 | delay between attempts |
| `COMMAND_OFFLINE_STATUS` | `FAILED` | final status when the station has no socket |
| `CPU_TEMP_THRESHOLD_C`, `GPU_TEMP_THRESHOLD_C` | 85, 90 | hardware alert thresholds |
| `TELEMETRY_CACHE_TTL_S` | 30 | Redis TTL of live telemetry |
| `TELEMETRY_HISTORY_INTERVAL_MS`, `TELEMETRY_HISTORY_RETENTION_HOURS` | 60000, 48 | telemetry history |

Docker Compose reads `.env` when it creates a container. After editing it, run `npm run docker:up`.

## Seed data

`npm run db:seed` fills the database (safe to run again). It creates 2 branches with machines and pricing, 6 games, membership and subscription plans, 2 managers, 4 employees and 10 gamers (one per XP tier), plus reservations and sessions in every status. All seeded accounts use the password `password123`. Usernames include `gamer.gold`, `gamer.silver`, `gamer.newbie`; see the header of [prisma/seed.ts](prisma/seed.ts) for the full list.

## Without Docker

You need your own Postgres 16 and Redis 7, and `DATABASE_URL` / `REDIS_URL` in `.env` pointing at `localhost`.

```bash
npm install
npx prisma migrate deploy
npx prisma generate
npx prisma db seed         # optional
npm run start:dev          # watch mode; or: npm run build && npm run start:prod
```

## Everyday commands

| command | role |
|:---|:---|
| `npm run docker:rebuild` | rebuild and replace the stale `node_modules` volume |
| `npm run docker:logs` | last 100 lines of every service, then follow |
| `npm run docker:ps` | status and health of each container |
| `npm run docker:sh` | shell inside the backend container |
| `npm run db:migrate -- --name <name>` | create and apply a migration (after editing `prisma/schema.prisma`) |
| `npm run db:deploy` | apply existing migrations |
| `npm run db:generate` | regenerate the Prisma client into `src/generated/prisma` |
| `npm run db:reset` | **destructive**: drop and recreate the database |
| `npm run db:psql` | `psql` prompt |
| `npm run db:studio` | Prisma Studio on `:5555` |
| `npm run redis:cli` | `redis-cli` in the Redis container |
| `npm run caddy:validate` / `caddy:reload` | check / hot-reload the `Caddyfile` |
| `npm run caddy:ca` | export Caddy's root certificate to `./caddy-root.crt` |
| `npm run lint` | oxlint |
| `npm test` | unit tests |
| `npm run test:int` | integration tests inside the container (real Postgres and Redis) |
| `npm run docs:build` | rebuild the static API docs (see [docs/SWAGGER.md](docs/SWAGGER.md)) |

### If I change X, what do I run?

| change | run |
|:---|:---|
| anything under `src/` | nothing, watch mode reloads |
| `prisma/schema.prisma` | `npm run db:migrate -- --name <name>` then `npm run db:generate` |
| a migration from a teammate | `npm run db:deploy`, then `npm run db:generate` |
| `package.json` or the lockfile | `npm run docker:rebuild` |
| `Dockerfile` | `npm run docker:dev` |
| `docker-compose*.yml` or `.env` | `npm run docker:up` |
| `Caddyfile` | `npm run caddy:reload` |

To wipe local data and start clean: `npm run dc -- down -v`, then `npm run docker:dev`. This drops `pgdata`, `redisdata` and `caddy_data` (the pinned certificate changes too).

## Production

```bash
docker compose up -d --build     # base file only: target `runtime`, NODE_ENV=production
```

* With `NODE_ENV=production`, Swagger (`/docs`) and the dev-only `/ops/commands` controller are off.
* Only Caddy publishes a port (`443`). Backend, Postgres and Redis stay on the internal network.
* The base compose file also runs a `cloudflared` quick tunnel to Caddy's plain `:80` listener. Remove that service if you do not use it.
* Stopping `backend` is graceful (20 s) so BullMQ finishes in-flight jobs and Prisma disconnects.
* Run only one backend instance: the agent registry is in memory.

## Realtime endpoints

| path | protocol | who |
|:---|:---|:---|
| `/agent-ws` | raw WebSocket, JSON envelope | the desktop agent on each gaming PC; authenticated with a station token |
| `/dashboard-io` | socket.io | staff dashboards (live station feed) and the gamer's own events; authenticated with the user access token |

Station enrollment (how a PC gets its machine row and station token) is not built yet. Until it ships, a machine and its token are provisioned by hand.

## Known limits

* One backend instance only (in-memory agent registry).
* No station-token revocation list: `enrollmentStatus` and `credentialVersion` on the machine are the revocation.
* On Docker Desktop (Windows / macOS) inbound traffic is NATed, so the station IP shown in dev is Docker's gateway, not the PC.

## Troubleshooting

* **`Cannot read properties of undefined (reading 'validator')` in tests, or the backend container exits at start.** The generated Prisma client in `src/generated/prisma/runtime/` was written empty. On Windows / OneDrive bind mounts the container's `prisma generate` can fail with `EPERM: operation not permitted, copyfile`. Run `npx prisma generate` on the host, then `npm run docker:up`.
* **Backend slow to become healthy on first start.** The first compile inside the container is slow; the dev healthcheck allows 120 s.
* **`node_modules` mismatch after a dependency change.** Run `npm run docker:rebuild`.

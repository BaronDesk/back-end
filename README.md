# cstam backend
This document highlights the architecture used, each piece's role, and outliens the development workflow.

## Table of content
* [Tech Stack & Structure](#tech-stack-and-structure)
* [Usage & Diagnostics](#usage-and-diagnostics)

## Tech Stack and Structure
* Node 24
* NestJS 12
* Fastify 5
* Prisma 7
* Redis 7
* BullMQ 6
* Postgres 16
* Caddy 2

### Topology
The agents/browser, acts from outside and only sees Caddy. \
Containers communicate together by Compose service name and everything runs on a network called `internal`.

```mermaid
architecture-beta
    group api[TOPOLOGY]

    service ab(internet)[Agents/Browser]
    service rp(server)[Reverse-Proxy (:443 TLS)] in api
    service be(server)[Backend (:3000)] in api
    service pg(database)[Postgres (:5432)] in api
    service rd(disk)[Redis (:6379)] in api

    ab:R --> L:rp
    rp:B --> T:be
    be:R -- L:pg
    be:R -- L:rd

    align column rd pg
    align row ab rp rd
    align row be pg
    align column rp be
```

|service      |image      |role     |state|
|:---         |:---       |:---    |:---:|
|reverse-proxy|caddy:2-alpine|TLS certificates from internal CA, REST/WS proxy|caddy_data, caddy_config|
|backend      |cstam-backend|REST API, Swagger, WS gateways, queue worker|-|
|migrate      |cstam-backend|Runs `prisma migrate deploy` once|-|
|postgres     |postgres:16-alpine|Database, checked with `pg_isready`|pgdata|
|redis        |redis:7-alpine|BullMQ broker with AOF for logging|redisdata|

The migration is its own container, and `backend` doesn't start until it's finished successfully (avoids race condition).

> [!CAUTION]
> inside a container, `localhost` means _this container_. To refer to services, you may use `postgres:5432`, `redis:6379`, `backend:3000`.
> To keep in mind when setting up a new env file.

### Boot order
1. `postgres` and `redis` start
2. Migration doesn't start until `postgres` is healthy, then runs `prisma migrate deploy` and exits
3. `backend` doesn't start until `migrate` service completed successfully and `redis` is healthy (passed healthcheck), then boots Nest.
4. `backend` keeps polling itself over HTTP until it gets an answer (checking for health)
5. `reverse-proxy` doesn't start until `backend` is healthy  and binds itself to :443

`backend` shutdown was made graceful with a grace period of 20s to give BullMQ time to handle in-flight jobs and Prisma time to disconnect, instead of SIGTERM killing mid-job.

### Stages
|stage|from|purpose|
|:--- |:---|:---:|
|`base`|`node:24-bookworm-slim`|Necessary for every next stage (OpenSSL, WORKDIR /app)|
|`deps`|`base`|Single stage to hit npm registry with cache mount (changed lockfile re-resolves)|
|`dev`|`deps`|Runnable environment, entrypoint to regenerate Prisma client, then `nest start --watch`|
|`builder`|`deps`|Produces artifacts for runtime|
|`runtime`|`base`|Production, copies out of `builder` stage, runs as `node`|

The `dev` stage overwrites `/app` to not bake sources. It's also the reason why Prisma generation with `dev-entrypoint.sh` was moved out to be used by every container at its start.

`node_modules` is set as an anonymous volume so it wouldn't use the host's binaries (important since the platforms may not match).

### Dev vs production builds

The base `docker-compose.yml` is production-shaped. \
`docker-compose.dev.yml` is an override layer on top.

|               |base       |dev override   |reason            |
|:---           |:---:      |:---:          |:---              |
|build target   |`runtime`  |`dev`          |watch mode, source over bind mount|
|NODE_ENV       |`production`|`development` |unlock swagger at `/docs` and `/ops/commands` controller|
|backend ports  |`3000`     |`3000`, `9229` |door to Nest, anther for `node --inspect`|
|postgres,redis |not published|`5432`, `6379`|TablePlus, `psql`, `redis-cli` from host for debugging|
|Caddy ports    |`443`      |`443`, `80`     |HTTP->HTTPS redirect|
|volumes        |-          |`.:./app`, `/app/node_modules`|live source, new migration files land on host|
|healthcheck `start_period`|15s|120s, 12 retries|first in-container compile is slow|
|file watching  |-          |`CHOKIDAR_USEPOLLING`|for Docker Desktop only (only Windows); inotify events don't cross VM. Not needed on Linux|


> [!TIP]
> For dev build, we may either access our backend directly from Nest `:3000` or through Caddy `:443`.
> If there is a difference, we know to blame `reverse-proxy`

## Usage and Diagnostics

### Spinning up the project

#### First time
```bash
# Make a local copy and fill it with relevant values
cp .env.example .env

# Build + migrate + start, takes a while for the first time
npm run docker:dev

# Wait till the reverse-proxy starts
# it means all previous steps were sucessful
# open another terminal, check that all good
curl -s localhost:3000/health | jq
open http://localhost:3000/docs # to open http://localhost:3000/docs on your browser
```

#### Every subsequent run
```bash
npm run docker:up # wait a tiny bit
# work, edit files, see changes live
npm run docker:down # containers gone; pgdata + redisdata lingers
```
#### Other scripts...
|script             |role                               |
|:---               |:---                               |
|`docker:rebuild`   |replaces stale `node_modules` volume|
|`docker:logs`   |last 100 lines fromm all servivces|
|`docker:ps`   |status and health of each container|
|`docker:sh`   |shell inside the running backend|
|`db:migrate`/`db:deploy`|create migration/apply existing ones|
|`db:generate`/`db:reset`/`db:studio`/`db:psql`   |client codegen, destructive reset, prisma studio on `:5555`, `psql` prompt|
|`redis:cli`   |`redis-cli` inside redis container|
|`caddy:validate`/`caddy:reload`/`caddy:ca`|parse-check, hot reload, export root CA cert|
|`test:int`   |integration tests inside container, against real Postgres and REdis|

### Changes and what to run with them
This is a table that tells you "if I change X, what do I run?"

|change     |run    |reason|
|:---       |:---   |:---|
|anything under `src/`|nothing|tsc recompiles and Nest restarts itself, live editing|
|`prisma/schema.prisma`|`npm run db:migrate -- --name MIGRATION_NAME` then `npm run db:generate`|Generate writes into `src/`, recompilation follows automatically|
|Migration by a teammate|`npm run db:deploy`|Applies without prompting|
|`package.json`/lockfile|`npm run docker:rebuild`|Throw away stale `node_modules` volume|
|`Dockerfile`|`npm run docker:dev`|Rebuild|
|`docker-compose*.yml`/`.env`|`npm run docker:up`|Compose recreates what only changed, and env is read at container create|
|`Caddyfile`|`npm run caddy:reload`|No downtime or container restart, and open WebSockets survive|

> [!TIP]
> If it becomes wedged, you may run `npm run dc -- down -v` then `npm run docker:dev` to drop `pgdata`, `redisdata` and `caddy_data`, removing local data and invalidating pinned certs.

### Prisma client
How schema changes are done:
```bash
# 1.edit prisma/schema.prisma
# 2.create and apply migration
npm run db:migrate -- --name migration_name

# 3.regenerate the client into src/generated/prisma
npm run db:generate
```

The `DATABASE_URL` is read from `prisma.config.ts` for migrations.

### Queue, how a command flows
Here, the `CommandService` is the producer, `CommandProcessor` is the consumer, and the queue is `agent-commands`.
1. `POST /ops/commands` through CommandController, dev only and 404s on production
2. `CommandService.issue()` calls queue.add('command', {machineId, type, payload})
3. redis — bull:agent-commands:*
4. `CommandProcessor.process()` stands in for the agent-gateway round trip

Here is how to see it in action:
```bash
# TERMINAL 1
npm run docker:logs

# TERMINAL 2
curl -X POST localhost:3000/ops/commands \
  -H 'content-type: application/json' \
  -d '{"machineId":"01","type":"shutdown","payload":{}}'
  
# Back on TERMINAL 1, should show:
#   [CommandService]   queued job 1 (shutdown -> 01)
#   [CommandProcessor] active 1
#   [CommandProcessor] processing 1 attempt 1: shutdown -> m-001
#   [CommandProcessor] completed 1
```
`@OnWorkerEvent` handlers on the processor makes this readable.

We can as well look at Redis directly via `redis-cli`:
```bash
npm run redis:cli --scan --pattern 'bull:agent-commands:*'
npm run redis:cli LLEN  bull:agent-commands:wait
npm run redis:cli ZCARD bull:agent-commands:failed
npm run redis:cli HGETALL bull:agent-commands:1
npm run redis:cli ZREVRANGE bull:agent-commands:failed 0 4
```

Integration test against Redis can be ran with `npm run test:int` with `test/commands.e2e-spec.ts` which asserts a completed job and a retried failed job.

### Caddy
It acts as our public door, terminating TLS and proxying everything to the backend on `:3000`, the REST API and WS gateways. \
WebSocket upgrades (from normal HTTP request) don't need extra config, Caddy can hijack the connection when it sees `Upgrade: websocket`. \
The `cstam-server.local` isn't a real DNS name and would need to be added to hosts file pointing to 127.0.0.1. The hostnames define the SAN list on the cert Caddy's internal CA issues. Agents pin on the _pre-existing_ cert, otherwise it'd mean re-enrolling. \
The CAès root lives in `caddy_data` volume, surviving downs, but not with `-v` flag.

```bash
# 1.check for parsing
npm run caddy:validate

# 2.apply without dropping connection (WS survive)
npm run caddy:reload

# 3.names the the cert actually cover?
openssl s_client -connect localhost:443 -servername localhost </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName

# 4.we can curl Caddy's root without using "--insecure" flag
npm run caddy:ca # copies cert to root
curl --cacert ./caddy-root.crt https://localhost/health

# 5.is WS upgrade surviving the proxy?
npx wscat -n -c wss://localhost/agent-gateway
```

It is important to validate before reloading

### Reaching the stack
```bash
# straight to Nest, dev only
curl -s localhost:3000/health | jq
curl -s localhost:3000/ops/commands/counts | jq

# through Caddy, the way an agent will
curl -sk https://localhost/health | jq

# from inside the network
npm run docker:sh
wget -qO- http://backend:3000/health
nc -z postgres 5432 && echo "pg reachable"
getent hosts postgres redis backend
```

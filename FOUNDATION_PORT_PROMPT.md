# Task: port node tracking and telemetry onto the `foundation` branch

You are working on the `foundation` branch of the CSTAM backend (NestJS on Fastify, Prisma 7, Postgres, Redis). Your job is to rebuild, on top of `foundation`'s architecture, the node-tracking and telemetry features that were built on a separate line of work. Do not merge or cherry-pick that line of work. It uses a different toolchain and folder layout, so it must be re-implemented in `foundation`'s style.

The work is split into two parts:

- **Part 1: node tracking.** This covers station presence: online and offline, last seen, and IP.
- **Part 2: telemetry.** This covers hardware readings, alerts and history.

Each part must work on its own, and each part must be manually testable across several physical PCs on the same LAN. **After you finish a part, stop, report, and wait.** The user reviews the part, runs the physical test, and makes the commit themselves. Never run `git commit` or `git push`. Start Part 2 only when the user tells you to.

## Source of truth for the missing features

The features to port live on the local branch `archive/station-telemetry` (commit `e6fa0e2`). It exists only on this machine and is not pushed. Read files from it without checking it out:

```sh
git show archive/station-telemetry:src/modules/station/node-tracking.service.ts
git diff foundation archive/station-telemetry --stat
```

Read these files from the archive branch first. They explain the intent and the rules behind the code:

- `ARCHITECTURE.md`
- `src/modules/ops/REALTIME.md`
- `LAN-TESTING.md`: the runbook for testing between two PCs
- `scripts/node-monitor.ts`: a terminal dashboard used for the physical tests

The archive branch does not share history with `foundation` after commit `a6faac4`. Treat it as a reference implementation, not as a patch.

## What stays as `foundation` has it (do not change)

- **Toolchain:** Nest 12, TypeScript 6, zod 4, vitest 5 with `unplugin-swc`, and ESM with `"module": "nodenext"` and `.js` import suffixes. Keep oxlint, prettier, swagger, and the `docker:*` and `db:*` npm scripts.
- **Config:** `@nestjs/config` with the zod schema in `src/config/env.schema.ts`. Read config through `ConfigService`. Never read `process.env` outside `env.schema.ts` and `main.ts`. Do not port the archive's `src/config/env.ts`.
- **Layout:** infrastructure goes in `src/infra/` (Prisma, realtime, and now Redis and security). Each feature module uses `controllers/`, `services/`, `repository/` and `schemas/` subfolders, with one repository per aggregate. Every repository extends `BaseRepository`.
- **Authorization model:**
  - `JwtAuthGuard` and `PermissionsGuard` are global `APP_GUARD`s.
  - Routes declare `@Public()`, `@RequireScope()` or `@Permissions()` as metadata only.
  - Target checks (branch, owner, role) happen in services, through `assertScope` and similar helpers.
  - Do not port the archive's per-route `UseGuards` decorators, `ScopeGuard`, `resolveBranchId`, `ownerParam` or `DenyByDefaultGuard`. `PermissionsGuard` already denies by default.
- **Dependency injection:** `foundation` compiles tests with swc, which emits decorator metadata, so implicit constructor injection works. Do not add the archive's explicit `@Inject(Class)` to every constructor. If a test fails with "Nest can't resolve dependencies", fix the swc config instead.
- **Automated tests:** e2e tests run against a real Postgres through `vitest.config.e2e.ts`. Unit specs sit next to the code as `*.spec.ts`. Do not port the archive's `tests/helpers/fake-prisma.ts` or its flat `tests/` folder.

## Rules for manual (physical) testing tools

The physical-test tooling is **temporary**. The npm test suites are permanent and follow the normal rules. For everything else built for manual testing, these rules apply:

- Put all of it in one folder at the repo root: `manual-testing/`. Nothing for manual testing goes anywhere else.
- **Scripts must not import anything from `src/`.** Talk to the backend only over HTTP, WebSocket and Socket.IO, the way a real client does.
- **Do not change `src/`, `package.json` or config files to support manual testing.** Do not add npm scripts for manual testing. Run the scripts with `npx tsx manual-testing/<script>.ts`.
- Start each script with the comment `// TEMPORARY — manual LAN testing only. Delete manual-testing/ when done.`
- Removing the whole folder (`rm -r manual-testing`) must break nothing and must leave every automated test passing. Check this before you report a part as done.
- `manual-testing/README.md` is the runbook. Adapt the archive's `LAN-TESTING.md` to `foundation`. There are two roles:
  - **HOST** runs the backend, Postgres and Redis. The simplest option is `npm run docker:dev`, which publishes the backend on port `3000`.
  - **CLIENT** PCs run the fake agent or the monitor.

  Cover these topics:
  - finding the HOST's LAN IP
  - the Windows firewall rule for port `3000`, and the Private network profile
  - checking `curl http://<HOST_IP>:3000/health` from a CLIENT
  - getting an access token by logging in as the seeded admin
  - what to run on each PC and what the tester should see

  If Postgres port `5432` conflicts with a native Postgres on Windows, write the workaround in the README. Do not change `docker-compose.dev.yml`.

## Part 1: node tracking

**Goal:** a CLIENT PC connects as a station. A staff dashboard sees that station go ONLINE and, when the station stops, sees it go OFFLINE within about 10 seconds. The same state is also available over REST.

### 1.1 Foundation fixes (needed by both parts)

1. **Move `TokenService` out of `identity`.** Create `src/infra/security/security.module.ts`, a `@Global()` module that exports `TokenService`. Right now `src/common/guards/jwt-auth.guard.ts` imports from `modules/identity/...`, so the shared layer depends on a feature module. After the move, `common/` and `infra/` must not import from `modules/`.
2. **Harden JWTs.** Sign with `algorithm: "HS256"` and verify with `algorithms: ["HS256"]`, and add an `issuer` claim. Add `JWT_ISSUER` to the env schema, with default `cstam-identity`. Reference: `git show archive/station-telemetry:src/security/token.service.ts`.
3. **Stop leaking 500 messages.** In `src/common/filters/all-exceptions.filter.ts`:
   - When `NODE_ENV === "production"`, return `"internal server error"` for non-HTTP errors. Keep logging the stack.
   - Map Fastify's own 4xx errors to their status. These are objects with a `statusCode` between 400 and 499, such as malformed JSON or payload too large.
   - Keep the `{ error, code, issues? }` body shape.
4. **Shared app setup.** Add `src/app.setup.ts` with `configureApp(app)`. It sets the `api/v1` global prefix (excluding `GET /health`), registers `@fastify/helmet`, and calls `enableCors()`. Call it from both `main.ts` and the e2e test bootstrap. Keep `trustProxy: true` and swagger in `main.ts`. Update the existing e2e tests for the new prefix.
5. **Typed request auth.** Add a `fastify.d.ts` augmentation so that `request.user` has type `AccessTokenPayload`, not `any`.

### 1.2 Prisma: presence columns

Apply only the `Machine` presence changes from `git diff foundation archive/station-telemetry -- prisma/schema.prisma`:

- Add `enum MachineStatus { ONLINE OFFLINE }`.
- Add these fields to `Machine`:
  - `status`, with default `OFFLINE` and an index
  - `lastSeen`, mapped to `last_seen`, timestamptz, nullable
  - `lastKnownIp`, mapped to `last_known_ip`, nullable
- Make `Machine.branchId` and `Machine.agentPublicKey` nullable. Change the branch relation to `onDelete: SetNull`.

Generate one migration with `prisma migrate dev --name node_tracking_presence`. Do not copy the archive's migration folders, because they were built on a different init migration.

### 1.3 Redis infrastructure

Add `src/infra/redis/redis.module.ts` (`@Global()`) and `redis.service.ts`, based on `git show archive/station-telemetry:src/redis/redis.service.ts`. The service needs:

- one command client
- a second client, created lazily, for `subscribe()`
- JSON `publish(channel, value)` and `subscribe<T>(channel, handler)`
- a small key/value API for the presence cache

Every call must catch and log its own errors, so that a Redis outage falls back to reading Postgres instead of crashing anything. Postgres stays the source of truth. Read `REDIS_URL` from `ConfigService`; it is already in the env schema.

### 1.4 `station` module

Create `src/modules/station/` in `foundation`'s layout. The references are under `archive/station-telemetry:src/modules/station/`.

- `repository/station.repository.ts` extends `BaseRepository`. It is the only code allowed to write the `Machine` presence columns.
- `services/node-tracking.service.ts` provides:
  - `markOnline`, `touch` and `markOffline`
  - the 10-second stale watchdog
  - the Redis presence cache, under the key `node:<machineId>`
  - presence-transition events that other modules can subscribe to
  - resolving a handshake's `serialNumber` to a `Machine` (see the security gate below)
- `services/station.service.ts` and `controllers/station.controller.ts` serve `GET /stations` and `GET /stations/:id`, with `@RequireScope('staff')`. Put the branch restriction in the service, using `assertScope`: `hq` sees every branch, and everyone else sees only their own branch.
- `StationModule` exports `NodeTrackingService`. No other module may write a `Machine` row.

### 1.5 Realtime: handshake, heartbeat and presence

- **Wire contract.** Move it into `src/infra/realtime/`. This means the envelope, the message-type constants, and the zod schemas for `handshake` and `heartbeat`, taken from `archive/station-telemetry:src/shared/schemas/realtime.schemas.ts` and `archive/station-telemetry:src/shared/types/realtime.ts`. Merge them with the existing `constants.ts`, `envelope.ts`, `frame.ts` and `seq-guard.ts`, and keep one definition of each concept. Add the telemetry-related schemas in Part 2, not here.
- **Agent gateway** (`agent.gateway.ts`):
  - Replace `new WebSocketServer({ server, path })` with `new WebSocketServer({ noServer: true })`, plus an `upgrade` listener that handles only `/agent-ws`. The listener must ignore every other path, including Socket.IO's `/dashboard-io`.
  - Remove the listener in `onModuleDestroy`.
  - A connection has no identity until its first valid `handshake` frame.
  - The gateway sends only `handshake_ack` and `heartbeat_ack`.
  - Log and drop any invalid or out-of-order frame. Never answer with a nack.
  - Handshake and heartbeat call `NodeTrackingService`. Record the client IP from the socket. The server sits behind Caddy, so honor `X-Forwarded-For` / `X-Real-IP`.

  Reference: `git show archive/station-telemetry:src/modules/ops/agent-gateway.ts`.
- **Dashboard gateway** (`dashboard.gateway.ts`):
  - Keep token verification when the client connects.
  - Subscribe to `NodeTrackingService` presence transitions, and re-emit them to the right branch room as `station_status`.
  - Publish the transitions through Redis, so that dashboards connected to different replicas all receive them.

### Security gate: stop and ask before auto-provisioning

In the archive, `/agent-ws` has no authentication, and a handshake with an unknown `serialNumber` automatically creates a `Machine` row. Do not port that behavior as it is.

**Before you write the handshake logic, stop and ask the user two questions:**

1. Which station credential scheme should the handshake use? For example, an enrollment token, or a signature checked against `agentPublicKey` (ADR-003).
2. Is auto-provisioning allowed at all?

Until the user answers, reject any handshake from a machine that is not already enrolled. For the physical test, add `manual-testing/enroll-machine.ts`. It enrolls a serial number through the API if an endpoint exists. If no endpoint exists, it prints the SQL for the tester to run with `npm run db:psql`. Do not add a real enrollment endpoint for testing unless the user asks for one.

### 1.6 Automated tests for Part 1 (permanent)

Write e2e tests in `test/` in the style of the existing `test/*.e2e-spec.ts`, and unit specs next to the pure logic. Use these archive tests as a checklist of behaviors to cover, not as code to copy:

- `tests/station.test.ts`: presence transitions and the branch-scoped REST routes
- the handshake and heartbeat cases in `tests/agent-gateway.test.ts`
- the `station_status` case in `tests/dashboard-gateway.test.ts`
- `tests/deny-by-default.test.ts`: a route with no policy metadata returns 403 `NO_ACCESS_POLICY`

### 1.7 Manual test kit for Part 1 (temporary)

Put these in `manual-testing/`:

- `fake-agent.ts`: run on a CLIENT PC with `BACKEND_URL=http://<HOST_IP>:3000 SERIAL=<serial> npx tsx manual-testing/fake-agent.ts`. It connects to `/agent-ws`, sends `handshake`, then sends a `heartbeat` every few seconds, and logs every frame it sends and receives. Ctrl+C stops the heartbeats so the tester can watch the station go OFFLINE. Run it on two or more CLIENT PCs at the same time, each with a different serial number.
- `monitor.ts`: a terminal dashboard adapted from `archive/station-telemetry:scripts/node-monitor.ts`. Run it with `TOKEN=<accessToken> BACKEND_URL=... npx tsx manual-testing/monitor.ts`. It connects to `/dashboard-io` and shows a live table of stations with their status, last-seen time and IP. For Part 1, show only the presence columns.
- `enroll-machine.ts`: described in the security gate above.
- `README.md`, with a Part 1 checklist:
  1. Enroll two serial numbers.
  2. Start the fake agent on CLIENT A and CLIENT B.
  3. Check that the monitor shows both stations ONLINE with the correct IPs.
  4. Stop CLIENT A and check that it shows OFFLINE within about 10 seconds.
  5. Call `GET /api/v1/stations` as the hq admin and as a staff user from another branch, and check that the branch scoping holds.
  6. Check that a serial number that is not enrolled is rejected.

### 1.8 Docs for Part 1

Add `ARCHITECTURE.md` at the repo root, adapted from the archive's version so that it describes `foundation`'s layout, toolchain and authorization model. Keep the "module DB privacy" rule and the table-ownership list. Add `src/modules/ops/REALTIME.md`, describing the handshake and heartbeat wire contract and the presence fan-out.

### End of Part 1: stop here

1. Run `npm run lint`, `npm run build`, `npm test` and `npm run test:e2e`. All four must pass. The e2e run needs Postgres and Redis, so start them with `npm run docker:up` first.
2. Temporarily move `manual-testing/` out of the repo, run the four commands again to confirm nothing depends on it, then move it back.
3. Report to the user:
   - the files you changed and created, as two groups: **permanent** and **temporary (`manual-testing/`)**
   - the test results
   - the Part 1 physical-test checklist
   - any decisions that are still open
4. Suggest a commit message, for example `feat(station): node tracking with Redis presence and agent handshake`. **Do not commit.** Wait for the user.

## Part 2: telemetry

Start this part only after the user confirms that Part 1 is committed.

**Goal:** a CLIENT PC streams hardware readings. The dashboard shows live values. Readings over a threshold raise alerts, which appear live and through REST. The server keeps a downsampled history.

### 2.1 Prisma: telemetry and alerts

Apply the remaining schema changes from the archive branch:

- Change `NodeTelemetry` to have `metrics Json` and `recordedAt` (mapped to `recorded_at`, with an index). Remove the old `metric`, `value` and `sampledAt` columns.
- Replace `TelemetryAlertType` with `enum AlertCategory { HARDWARE ANTI_THEFT SECURITY_VIOLATION }`.
- Change `TelemetryAlert` so that it has:
  - `branchId`: nullable, relation `onDelete: SetNull`, indexed
  - `category`: indexed
  - `type String`: indexed
  - `value Json?`
  - `severity`: default `MEDIUM`
- Add `telemetryAlerts TelemetryAlert[]` to `Branch`.

Generate the migration with `prisma migrate dev --name telemetry_alerts`.

### 2.2 `ops` telemetry and alerts

Extend `src/modules/ops/`. The references are under `archive/station-telemetry:src/modules/ops/`.

- `repository/ops.repository.ts` owns only `node_telemetry` and `telemetry_alerts`. `ops` reaches `machines` and `branches` only through `NodeTrackingService`.
- `services/telemetry.service.ts` does four things with each reading:
  - validates it
  - keeps the live value in Redis
  - checks it against the CPU and GPU temperature thresholds
  - publishes it on the `telemetry` Redis channel

  Add `CPU_TEMP_THRESHOLD_C` (default 85) and `GPU_TEMP_THRESHOLD_C` (default 90) to the env schema.
- `services/telemetry-history.service.ts` writes one downsampled row per machine about every 60 seconds, and deletes rows older than 48 hours.
- `services/alerts.service.ts` creates alerts and publishes them on the `alerts` Redis channel.
- `controllers/telemetry.controller.ts` and `controllers/alerts.controller.ts`: port the routes from the archive. Apply branch scoping in the service, the same way as in station.
- Add the `telemetry`, `state_report` and `device_event` payload schemas to `src/infra/realtime/`.
- **Agent gateway:** route `telemetry`, `state_report` and `device_event` frames to `TelemetryService`, `AlertsService` and `NodeTrackingService`. Do not add new outbound frame types.
- **Dashboard gateway:** subscribe to the `telemetry` and `alerts` Redis channels. Re-emit them to the branch rooms as `telemetry_update` and `alert`.

### 2.3 Automated tests for Part 2 (permanent)

Use the archive's `tests/telemetry.test.ts` as a checklist, and follow the same conventions as in 1.6:

- threshold alerts
- Redis publish
- history downsampling and pruning
- branch scoping on the telemetry and alert routes
- `telemetry_update` and `alert` reaching the right dashboard room

### 2.4 Manual test kit for Part 2 (temporary)

- Extend `manual-testing/fake-agent.ts` to also send `telemetry` frames. Read CPU and GPU temperatures from environment variables, or use a random walk when they are not set. Add a `HOT=1` option that pushes the values over the thresholds.
- Extend `manual-testing/monitor.ts` with the live CPU and GPU temperatures and fan RPM, and add an alert feed.
- Add a Part 2 checklist to `manual-testing/README.md`:
  1. Stream normal values from CLIENT A and hot values from CLIENT B.
  2. Check that the monitor shows live values for both stations, and alerts only for CLIENT B.
  3. Check that `GET` on the alerts route returns CLIENT B's alerts, scoped to its branch.
  4. After about 60 seconds, check that `node_telemetry` has downsampled rows. Use `npm run db:psql` to look.

### 2.5 Docs for Part 2

Update `ARCHITECTURE.md` with the table ownership for `node_telemetry` and `telemetry_alerts`. Update `REALTIME.md` with the telemetry frames and the Redis channels.

### End of Part 2: stop here

Follow the same checklist as at the end of Part 1: run the four commands, check that nothing depends on `manual-testing/`, and report with the permanent and temporary files as separate groups. Suggest a commit message, for example `feat(telemetry): telemetry ingestion, threshold alerts and history`. **Do not commit.** Tell the user that `manual-testing/` should be deleted once the physical tests pass.

## Do not port

- The archive's `src/config/env.ts`, `src/lib/` and `src/shared/`, and its top-level `src/prisma/`, `src/redis/` and `src/security/` folders. Their contents go under `infra/` or `common/`, as described above.
- The unused `bcryptjs`, `@types/bcryptjs` and `argon2id` dependencies, and the `BCRYPT_SALT_ROUNDS` setting. Hashing stays on `@node-rs/argon2`.
- `scripts/node-monitor.ts` as it is. Its replacement is `manual-testing/monitor.ts`.
- The archive's `AppError` hierarchy. Keep Nest `HttpException`s with `{ code, error }` bodies, as `foundation` already does.

# Architecture

This is the `identity/` slice of the CSTAM eSports Venue Management Platform:
authentication, RBAC, user/employee management, and the real-time transport layer
(`ops/`) that machine agents and the dashboard connect through. Fastify 5 + TypeScript
(CommonJS, strict) + Prisma 5 + Zod.

This doc explains what each part of the codebase does, how the pieces fit together,
and the rules to follow when adding to it. Read it before adding a new module or
touching `lib/`, `middleware/`, or `shared/`.

## Stack

- **Fastify 5** — HTTP server, plugin-based routing.
- **Prisma 5** — single `schema.prisma`, one Postgres database, one owner (see
  "Module DB privacy" below).
- **Zod** — request validation and static types (`z.infer`).
- **@fastify/jwt** — two independent namespaces (`access`, `refresh`), separate
  secrets, so a refresh token can never be replayed as an access token.
- **@node-rs/argon2** — password hashing (Argon2id).
- **raw `ws`** (via `@fastify/websocket`) — machine-agent transport.
- **Socket.IO** — dashboard transport.
- **Vitest** — the only test runner. All tests live in `tests/`, one flat folder,
  run with `npm test`.
- **tsx** — dev server (`npm run dev`) and one-off script execution.

## Directory layout

```
prisma/
  schema.prisma            # the one schema, single owner
  seed.ts                  # bootstraps one hq ADMIN account

src/
  app.ts                   # createApp(): builds and configures the Fastify instance
  server.ts                # main(): createApp() + app.listen() + graceful shutdown
  config/
    env.ts                 # typed env loader — the only file allowed to read process.env directly
  lib/                     # cross-cutting singletons, shared by every module
    prisma.ts              # PrismaClient singleton
    jwt.ts                 # @fastify/jwt setup + sign/verify/decode helpers
    password.ts             # Argon2id hash/verify
    app-error.ts            # AppError + subclasses -> {error, code} + HTTP status
    realtime/
      envelope.ts           # makeFrame / parseFrame / SeqGuard (anti-replay)
      registry.ts            # in-memory machineId -> ws connection map
  middleware/                # shared Fastify preHandler hooks
    validate.middleware.ts    # generic Zod body/params/query validator
    auth.middleware.ts        # authenticate / authenticateFresh (JWT -> req.auth)
    rbac.middleware.ts        # requireScope / allowAny — the RBAC gate
    error.middleware.ts       # setErrorHandler / setNotFoundHandler
  shared/
    types/
      auth.ts                 # Scope, SCOPE_RANK, ROLE_SCOPE, JWT claim shapes, AuthContext
      realtime.ts              # Envelope<T>, AGENT_MESSAGES, COMMANDS, DASHBOARD_EVENTS
      fastify.d.ts              # augments FastifyRequest with `auth?: AuthContext`
    schemas/
      realtime.schemas.ts       # Zod envelope/handshake/heartbeat schemas
  modules/
    identity/                    # auth + user/employee management (this module owns User, EmployeeProfile, GamerProfile, RefreshToken, AuditLog)
      identity.repository.ts      # the ONLY file that may import lib/prisma for these tables
      identity.schemas.ts          # all Zod request schemas for this module
      auth.service.ts               # login/refresh/logout/me business logic
      auth.controller.ts             # thin HTTP handlers, calls auth.service
      auth.routes.ts                  # registers /auth/* routes + preHandlers
      users.service.ts                 # signup/employee-creation/role-update logic
      users.controller.ts               # thin HTTP handlers, calls users.service
      users.routes.ts                    # registers /users, /employees routes
    ops/                          # real-time transport (no DB access yet)
      agent-gateway.ts             # GET /agent-ws — raw ws, machine agents
      dashboard-gateway.ts          # Socket.IO on /dashboard-io — dashboard clients
      REALTIME.md                    # install/wiring/testing notes for this module
  routes/
    index.ts                    # composition root — mounts every module's routes under /api/v1

tests/                         # ALL tests live here, one folder, one runner (vitest)
  setup.ts                      # global vi.mock("lib/prisma") -> fake-prisma, beforeEach reset
  helpers/
    app.ts                       # buildTestApp, seedUser, loginAs, setupWorld
    fake-prisma.ts                 # in-memory Prisma stand-in — no real DB in tests
  rbac.test.ts                  # requireScope/allowAny in isolation
  auth.test.ts                  # login, token claims/expiry, refresh rotation, logout
  users.test.ts                 # signup, role rules, cross-branch blocking
  agent-gateway.test.ts          # real ws client against a real listening app
  dashboard-gateway.test.ts       # real socket.io-client, real signed JWT

vitest.config.ts               # include: ["tests/**/*.test.ts"], fake env vars for tests
tsconfig.json                  # relative imports only — no baseUrl/paths
```

## The module pattern

Every feature module under `src/modules/<name>/` follows the same shape:

```
<name>.repository.ts   # the only file in the module allowed to import lib/prisma
<name>.schemas.ts       # all Zod schemas + inferred types for this module's routes
<name>.service.ts        # business logic — depends on the repository, not on prisma directly
<name>.controller.ts      # thin: parses req, calls the service, sets the reply
<name>.routes.ts           # registers Fastify routes + preHandler chains
```

`identity/` currently has two service/controller/route triples (`auth.*` and
`users.*`) sharing one `identity.repository.ts` and one `identity.schemas.ts`,
because they both operate on the same tables (`User`, `EmployeeProfile`,
`GamerProfile`, `RefreshToken`). A module with unrelated concerns should still
get one `<name>.repository.ts` per module, not per file.

### Module DB privacy — the important rule

**A module may only touch its own tables, and only through its own repository.**

- `import { prisma } from "../../lib/prisma"` is only allowed inside a module's
  own `<name>.repository.ts`.
- Services call the repository's exported functions — they never import
  `lib/prisma` directly.
- If module B needs data owned by module A, it calls into A's exported
  `<name>.service` — it does not read A's tables directly, even read-only.

This is what lets multiple people work on different modules without merge
conflicts in each other's queries, and keeps each table's invariants enforced
in exactly one place.

**Grandfathered exception:** `middleware/auth.middleware.ts`'s
`authenticateFresh()` queries `prisma.user` directly (for the "is this account
still active" re-check on sensitive endpoints). Middleware is shared
infrastructure, not a module, and predates this rule — leave it as-is, don't
use it as precedent for a module to import `lib/prisma` itself.

### Cross-module contracts live in `shared/`

`shared/types/` and `shared/schemas/` hold **only** things more than one module
needs to agree on:

- `shared/types/auth.ts` — the scope model (`Scope`, `SCOPE_RANK`, `ROLE_SCOPE`)
  and JWT claim shapes (`AccessTokenClaims`, `RefreshTokenClaims`, `AuthContext`).
- `shared/types/realtime.ts` + `shared/schemas/realtime.schemas.ts` — the WS
  envelope contract (`Envelope<T>`, `AGENT_MESSAGES`, `COMMANDS`,
  `DASHBOARD_EVENTS`, the envelope Zod schema).
- `shared/types/fastify.d.ts` — the `req.auth` ambient type augmentation.

Everything else — a module's request/response shapes, its own DTOs — belongs
in that module's `<name>.schemas.ts`, not in `shared/`. If you're adding a Zod
schema and only one module will ever import it, it does not belong in `shared/`.

## Auth & RBAC

### Scope model (`shared/types/auth.ts`)

```
public (0) < self (1) < staff (2) < admin (3) < hq (4)
```

| UserRole | Scope |
|---|---|
| GAMER | self |
| EMPLOYEE | staff |
| MANAGER | admin |
| ADMIN | hq |

Import `Scope` / `SCOPE_RANK` / `ROLE_SCOPE` from `shared/types/auth.ts` — never
hardcode a role-to-permission mapping anywhere else.

### Middleware chain

Hooks are plain async functions used in a route's `preHandler` array, run left
to right:

```ts
app.post(
  "/wallet/:id/topup",
  { preHandler: [authenticate, requireScope("self", { ownerParam: "id" }), validate(topupSchema)] },
  topupHandler
);
```

- **`authenticate`** (`auth.middleware.ts`) — verifies the Bearer access token,
  sets `req.auth`. Does not hit the DB (the JWT is the source of truth for
  identity/role/scope/branch on the hot path).
- **`authenticateFresh()`** — like `authenticate`, but re-checks `accountStatus`
  against the DB. Use only on sensitive, low-traffic endpoints.
- **`requireScope(min, opts)`** (`rbac.middleware.ts`) — the RBAC gate:
  - rank check: caller's scope must be `>= min` (`hq` passes everything).
  - `ownerParam`/`ownerBody`: only enforced when the caller's scope is exactly
    `self` — lets a "self or staff" endpoint be one line.
  - `branchParam`/`resolveBranchId`: only enforced for `staff`/`admin` callers
    (not `hq`, not `self`) — blocks cross-branch access automatically.
- **`allowAny(...scopes)`** — for endpoints whose allowed set isn't a clean
  "minimum rank" (e.g. only `self` and `hq`).
- **`validate(schema)`** (`validate.middleware.ts`) — parses `{body, params,
  query}` against a Zod object schema, writes the coerced values back onto the
  request, throws `BadRequestError` (`VALIDATION_ERROR`) on failure.

Even after `requireScope` passes, service logic re-checks anything the
middleware can't see cheaply (e.g. "does this session belong to this user's
branch") — every powerful action is checked at both layers.

### JWT — a known library gotcha

`@fastify/jwt`'s `sign(payload, options)` does **not merge** `options` with the
plugin's registration-level defaults (`sign: { iss, expiresIn }`) — internally
it's `options || defaultOptions`, i.e. pick one, not merge. Since every real
call site needs to pass `{ sub, jti }` as the second argument, the registration
defaults get silently dropped unless you repeat them.

**Every `sign()` call site must explicitly pass `expiresIn` and `iss`.** See
`signAccessToken`/`signRefreshToken` in `lib/jwt.ts` for the pattern. Forgetting
this produces a token that verifies successfully forever (no `exp` claim at
all) — this bit us once already; don't reintroduce it.

For the same reason, `decodeExpiry()` does not use `@fastify/jwt`'s `.decode()`
— it decodes the JWT payload by hand (base64url + `JSON.parse`) to avoid the
same options-merging trap.

If you ever manually craft a token in a test to simulate expiry: `fast-jwt`
(the library `@fastify/jwt` v9 uses under the hood) reads a custom `iat`
override from the **payload** (first argument), in **seconds**, not from the
`options` argument and not in milliseconds. Getting this wrong produces a
token that looks freshly issued instead of expired.

### Passwords

Argon2id via `@node-rs/argon2`, wrapped in `lib/password.ts`:

```ts
hashPassword(plain: string): Promise<string>
verifyPassword(storedHash: string, plainText: string): Promise<boolean>
```

Note the argument order on `verifyPassword`: `(storedHash, plainText)`,
matching the underlying `argon2.verify(hash, password)` convention — the
opposite order from `bcrypt.compare(plain, hash)`, which this module used to
use. Don't flip it back.

## Real-time layer (`modules/ops/`)

Two independent transports, both framed with the same `Envelope<T>` shape
(`type`, `id`, `ts`, `seq`, `payload`) so replay/ordering is checked
identically on both sides:

- **`agent-gateway.ts`** — `GET /agent-ws`, raw `ws` (via `@fastify/websocket`,
  registered by this plugin itself). Machine agents connect with
  `?machineId&token`. Per-connection `SeqGuard` rejects a replayed/out-of-order
  `seq` or a `ts` more than 30s from server time. Registered in-memory in
  `lib/realtime/registry.ts` (`machineId -> ws`).
- **`dashboard-gateway.ts`** — Socket.IO on path `/dashboard-io`. `io.use`
  verifies `handshake.auth.token` via `verifyAccessToken` (the same access
  token as the REST API), joins the caller's `branch:<branchId>` room (`hq` or
  a `null` branchId joins `branch:all`). `publishToBranch(io, branchId, event,
  payload)` is the one function business logic should call to push a
  `DashboardEvent` out.

Neither gateway touches the database yet — when one needs to, it gets its own
`ops.repository.ts` per the module DB privacy rule above.

`verifyStation()` in `agent-gateway.ts` is a stub: it only checks that
`machineId`/`token` are present, not that they're valid against
`Machine.agentPublicKey`. See `modules/ops/REALTIME.md` for wiring and testing
details specific to this module.

## Testing

**All tests live in `tests/`, one folder, run with `npm test` (Vitest).** No
per-module `*.spec.ts` files, no second test runner, no real database —
`tests/setup.ts` mocks `lib/prisma` globally with an in-memory fake
(`tests/helpers/fake-prisma.ts`), reset before every test.

- `tests/rbac.test.ts` — `requireScope`/`allowAny` in isolation.
- `tests/auth.test.ts` — login, token claims/expiry (via `vi.useFakeTimers`),
  refresh rotation + reuse detection, logout, suspended accounts, audit log.
- `tests/users.test.ts` — signup, role-escalation rules, cross-branch
  blocking.
- `tests/agent-gateway.test.ts` / `tests/dashboard-gateway.test.ts` — real `ws`
  / `socket.io-client` connections against a real listening app on an
  ephemeral port (no HTTP mocking for these two — they need a real socket).

`tests/helpers/app.ts` exports `buildTestApp()`, `seedUser()`, `loginAs()`,
`setupWorld()` (one logged-in user per role/branch) — reuse these instead of
re-deriving fixtures in a new test file.

Run: `npm test` (once) or `npm run test:watch` (watch mode).

## Do / Don't when developing here

**Do:**
- Put a new feature under `src/modules/<name>/`, following the
  repository/schemas/service/controller/routes shape.
- Give every module its own `<name>.repository.ts` and route all DB access
  through it.
- Add cross-module Zod/types to `shared/` only when more than one module
  genuinely needs them.
- Use relative imports (`../../lib/...`) everywhere — `tsconfig.json` has no
  `baseUrl`/`paths`, so `@/*`-style imports will not resolve.
- Add new tests to `tests/`, named after what they cover
  (`<subject>.test.ts`), using Vitest's `test`/`expect`/`vi`.
- Explicitly pass `expiresIn`/`iss` at every `@fastify/jwt` `.sign()` call
  site (see the JWT gotcha above).
- Run `npm test` and `npx tsc --noEmit` before considering a change done.

**Don't:**
- Don't `import { prisma } from "../../lib/prisma"` outside a module's own
  `<name>.repository.ts` (exception: `middleware/auth.middleware.ts`'s
  `authenticateFresh`, grandfathered — don't extend that pattern elsewhere).
- Don't put a feature-specific Zod schema in `shared/schemas/` — it belongs in
  the module that owns it.
- Don't hardcode a role/permission check — import `Scope`/`SCOPE_RANK`/
  `ROLE_SCOPE` from `shared/types/auth.ts`.
- Don't add a second test folder or a second test runner — everything goes
  through Vitest in `tests/`.
- Don't call `@fastify/jwt`'s `.sign()` with a call-level `options` argument
  that omits `expiresIn`/`iss` — it silently produces a non-expiring token
  (see the JWT gotcha above).
- Don't run `bcrypt`-style `(plain, hash)` argument order on `verifyPassword`
  — it's `(storedHash, plainText)` here.
- Don't hand-edit `tsconfig.json`'s `ignoreDeprecations` to `"6.0"` — the
  project's installed compiler (check `node_modules/typescript/package.json`)
  only accepts `"5.0"`. If your editor's IDE keeps suggesting `"6.0"`, your
  editor's TypeScript version and the project's installed one are out of
  sync — pin the workspace TypeScript version instead of trusting that
  quick-fix.
- Don't remove `package-lock.json` changes during a merge without running
  `npm install` afterward — a dependency added by a merge but never installed
  fails at import time, not at merge time, which reads as a confusing test
  failure later.

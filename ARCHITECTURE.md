# Architecture

This is the `identity/` slice of the CSTAM eSports Venue Management Platform:
authentication, RBAC, user/employee management, and the real-time transport layer
(`ops/`) that machine agents and the dashboard connect through. **NestJS 11 on the
Fastify adapter** + TypeScript (CommonJS, strict) + Prisma 7 (driver adapter) + Zod.

This doc explains what each part of the codebase does, how the pieces fit together,
and the rules to follow when adding to it. Read it before adding a new module or
touching `common/`, `security/`, `prisma/`, `lib/` or `shared/`.

## Stack

- **NestJS 11** (`@nestjs/common`, `@nestjs/core`) — modules, dependency injection,
  controllers, guards, pipes, exception filters. Built with `nest build`
  (`@nestjs/cli`), matching this repo's `Dockerfile`/`docker-compose` — don't
  switch it back to a bare `tsc` script.
- **Fastify 5** via `@nestjs/platform-fastify` — the HTTP server underneath Nest.
  `fastify` is pinned to the exact version `@nestjs/platform-fastify` bundles
  (`5.11.3`); a looser `^5.0.0` range lets npm hoist a second, incompatible
  copy and `app.setup.ts`'s `helmet` registration stops type-checking.
- **Prisma 7**, driver adapter (`@prisma/adapter-pg` + `pg`), single
  `schema.prisma`, one Postgres database, one owner per table (see "Module DB
  privacy" below). Client generates to `src/generated/prisma` (see
  `generator client` in `schema.prisma`) rather than the `@prisma/client`
  default — that's the path `nest-cli.json`'s `assets` and the `Dockerfile`'s
  builder stage both expect. Wrapped in an injectable `PrismaService`.
- **Zod** — request validation and static types (`z.infer`), applied with
  `ZodValidationPipe`. (Not class-validator.)
- **@nestjs/jwt** — signs/verifies access and refresh tokens with **separate
  secrets**, so a refresh token can never be replayed as an access token.
- **@node-rs/argon2** — password hashing (Argon2id).
- **raw `ws`** — machine-agent transport.
- **Socket.IO** — dashboard transport.
- **@fastify/helmet** — security headers (CORS via `app.enableCors()`).
- **Vitest** + **@nestjs/testing** — the only test runner. All tests live in `tests/`,
  one flat folder, run with `npm test`.
- **tsx** — dev server (`npm run dev`) and one-off script execution.

## Directory layout

```
prisma/
  schema.prisma            # the one schema, single owner
  seed.ts                  # bootstraps one hq ADMIN account

src/
  main.ts                  # bootstrap(): NestFactory + FastifyAdapter + listen
  app.module.ts            # root module: wires every feature module together
  app.setup.ts             # configureApp(app): /api/v1 prefix, helmet, CORS, exception filter
                           #   (shared by main.ts and the tests)
  config/
    env.ts                 # typed env loader — the only file allowed to read process.env directly
  prisma/
    prisma.module.ts       # @Global — exports PrismaService
    prisma.service.ts      # PrismaClient (adapter-pg driver adapter) as an
                           #   injectable, connect/disconnect lifecycle
  generated/
    prisma/                 # `prisma generate` output (gitignored) — import
                           #   from here, never from "@prisma/client" directly
  security/
    security.module.ts     # @Global — exports TokenService
    token.service.ts       # sign/verify access + refresh JWTs, decodeExpiry, Authorization header parsing
  common/                  # Nest building blocks shared by every module
    guards/
      auth.guard.ts        # Bearer JWT -> req.auth (no DB hit)
      fresh-auth.guard.ts  # same, plus a DB check of accountStatus
      scope.guard.ts       # enforces the rule set by @RequireScope / @AllowAny
      deny-by-default.guard.ts  # global APP_GUARD: rejects any route with no
                                 #   @Public()/@Auth()/@RequireScope()/@AllowAny() marker
    decorators/
      access.decorators.ts # @Auth, @RequireScope, @AllowAny — the public API for protecting routes
      public.decorator.ts  # @Public() — opts a route out of DenyByDefaultGuard
      current-auth.decorator.ts  # @CurrentAuth() -> the caller's AuthContext
    rbac/
      scope-rules.ts       # checkScope / checkAnyScope — the RBAC rules as plain, unit-testable functions
    pipes/
      zod-validation.pipe.ts     # ZodValidationPipe(schema) for @Body/@Param/@Query
    filters/
      all-exceptions.filter.ts   # every error -> { error, code } + HTTP status
  lib/                     # framework-free helpers
    app-error.ts           # AppError + subclasses -> {error, code} + HTTP status
    password.ts            # Argon2id hash/verify
    realtime/
      envelope.ts          # makeFrame / parseFrame / SeqGuard (anti-replay)
      registry.ts          # MachineRegistry provider: in-memory machineId -> ws connection map
  health/
    health.controller.ts   # GET /health (outside the /api/v1 prefix)
  shared/
    types/
      auth.ts              # Scope, SCOPE_RANK, ROLE_SCOPE, JWT claim shapes, AuthContext
      realtime.ts          # Envelope<T>, AGENT_MESSAGES, COMMANDS, DASHBOARD_EVENTS
      fastify.d.ts         # augments FastifyRequest with `auth?: AuthContext`
    schemas/
      realtime.schemas.ts  # Zod envelope/handshake/heartbeat schemas
  modules/
    identity/              # auth + user/employee management (owns User, EmployeeProfile, GamerProfile, RefreshToken, AuditLog)
      identity.module.ts        # declares controllers/providers, exports AuthService + UsersService
      identity.repository.ts    # the ONLY provider that may inject PrismaService for these tables
      identity.schemas.ts       # all Zod request schemas for this module
      auth.service.ts / auth.controller.ts    # login/refresh/logout/me
      users.service.ts / users.controller.ts  # signup/employee-creation/role-update/get
    ops/                   # real-time transport (no DB access yet)
      ops.module.ts
      agent-gateway.ts     # ws on /agent-ws — machine agents
      dashboard-gateway.ts # Socket.IO on /dashboard-io — dashboard clients
      REALTIME.md          # wiring/testing notes for this module

tests/                     # ALL tests live here, one folder, one runner (vitest)
  setup.ts                 # reflect-metadata + reset the fake DB before every test
  helpers/
    app.ts                 # buildTestApp, startTestServer, seedUser, loginAs, setupWorld
    db.ts                  # the shared in-memory fake Prisma instance
    fake-prisma.ts         # in-memory Prisma stand-in — no real DB in tests
  rbac.test.ts             # checkScope/checkAnyScope in isolation
  auth.test.ts             # login, token claims/expiry, refresh rotation, logout
  users.test.ts            # signup, role rules, cross-branch blocking
  agent-gateway.test.ts    # real ws client against a real listening app
  dashboard-gateway.test.ts  # real socket.io-client, real signed JWT

vitest.config.ts           # include: ["tests/**/*.test.ts"], fake env vars for tests
tsconfig.json              # relative imports only — no baseUrl/paths; decorators enabled
```

## The module pattern

Every feature module under `src/modules/<name>/` follows the same shape:

```
<name>.module.ts       # @Module: controllers, providers, exports
<name>.repository.ts   # @Injectable — the only provider in the module allowed to inject PrismaService
<name>.schemas.ts      # all Zod schemas + inferred types for this module's routes
<name>.service.ts      # @Injectable — business logic; depends on the repository, not on Prisma
<name>.controller.ts   # @Controller — thin: validates input, calls the service
```

Register the module in `app.module.ts`'s `imports`.

`identity/` has two service/controller pairs (`auth.*` and `users.*`) sharing one
`identity.repository.ts` and one `identity.schemas.ts`, because they operate on the
same tables (`User`, `EmployeeProfile`, `GamerProfile`, `RefreshToken`). A module
with unrelated concerns should still get one `<name>.repository.ts` per module,
not per file.

### Dependency injection: always `@Inject(Class)` explicitly

```ts
constructor(@Inject(TokenService) private readonly tokens: TokenService) {}
```

Never rely on the bare `constructor(private readonly tokens: TokenService)` form.
Nest normally reads constructor types from `emitDecoratorMetadata`, but **tsx (dev
server) and Vitest both compile with esbuild, which does not emit that metadata** —
implicit injection would work under `tsc` and fail everywhere else with "Nest can't
resolve dependencies". The explicit `@Inject(...)` works in all three. Import the
class as a value (not `import type`), since it is used at runtime.

### Module DB privacy — the important rule

**A module may only touch its own tables, and only through its own repository.**

- `PrismaService` may only be injected into a module's own `<name>.repository.ts`.
- Services call the repository's methods — they never inject `PrismaService`.
- If module B needs data owned by module A, it imports A's module and calls A's
  exported service (e.g. `UsersService`) — it does not read A's tables, even read-only.

This is what lets multiple people work on different modules without merge
conflicts in each other's queries, and keeps each table's invariants enforced
in exactly one place.

**Grandfathered exception:** `common/guards/fresh-auth.guard.ts` injects
`PrismaService` directly (for the "is this account still active" re-check on
sensitive endpoints). It is shared infrastructure, not a module, and predates
this rule — leave it as-is, don't use it as precedent.

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
in that module's `<name>.schemas.ts`, not in `shared/`.

## Request lifecycle

```
request -> Fastify (JSON parse) -> guards -> pipes -> controller -> service -> repository -> Prisma
                                     |         |
                                  401 / 403   400          any error -> AllExceptionsFilter -> { error, code }
```

Guards run **before** pipes, so an unauthenticated or unauthorized caller gets
401/403 rather than a validation error.

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

### Protecting a route

**Every route must carry one of `@Public()`, `@Auth()`, `@RequireScope()` or
`@AllowAny()`.** `DenyByDefaultGuard` (`common/guards/deny-by-default.guard.ts`)
is a global `APP_GUARD` that rejects (403 `NO_ACCESS_POLICY`) any route
carrying none of the four — a forgotten decorator fails closed instead of
silently becoming public.

```ts
@Controller("wallet")
export class WalletController {
  // deliberately open, no auth at all
  @Get("ping")
  @Public()
  ping() {}

  // any logged-in user
  @Get("me")
  @Auth()
  mine(@CurrentAuth() auth: AuthContext) {}

  // a gamer may top up their own wallet; any staff+ can do it for them
  @Post(":id/topup")
  @RequireScope("self", { ownerParam: "id" })
  topUp(@Param(new ZodValidationPipe(idParam)) params: IdParam, @Body(new ZodValidationPipe(topUpSchema)) body: TopUp) {}

  // only the machine's own branch manager (or hq); resolveBranchId may be async
  @Post("enrollment/:machineId/approve")
  @RequireScope("admin", { resolveBranchId: (req) => lookupBranch((req.params as any).machineId) })
  approve() {}

  // not a clean "minimum rank": only self and hq
  @Delete(":id")
  @AllowAny("self", "hq")
  remove() {}
}
```

- **`@Auth()`** — verifies the Bearer access token, sets `req.auth`. No DB hit (the
  JWT is the source of truth on the hot path). `@Auth({ fresh: true })` also
  re-checks `accountStatus` in the DB — use only on sensitive, low-traffic endpoints.
- **`@RequireScope(min, opts)`** — the RBAC gate. **Already authenticates — don't add
  `@Auth()`.** Caller's scope must be `>= min` (`hq` passes everything).
  - `ownerParam`/`ownerBody`: only enforced when the caller's scope is exactly `self`.
  - `branchParam`/`resolveBranchId`: only enforced for `staff`/`admin` callers (not
    `hq`, not `self`) — blocks cross-branch access automatically.
  - `fresh: true`: use the DB-checking auth guard.
- **`@AllowAny(...scopes)`** — for allowed sets that aren't a minimum rank. Also authenticates.
- **`@Public()`** — the *only* other way to satisfy `DenyByDefaultGuard`. Use it
  for genuinely unauthenticated routes (login, signup, health, refresh).
- **`@CurrentAuth()`** — parameter decorator returning the caller's `AuthContext`.

The rules themselves live in `common/rbac/scope-rules.ts` as plain functions
(`checkScope`, `checkAnyScope`) so they are unit-tested without Nest.

Even after a guard passes, service logic re-checks anything the guard can't see
cheaply (e.g. "does this session belong to this user's branch") — every powerful
action is checked at both layers.

### Validation

Zod, one schema per request part, attached with a pipe:

```ts
create(@Body(new ZodValidationPipe(createGamerSchema)) body: CreateGamerInput) {}
```

The handler receives the parsed, sanitized value (unknown keys stripped, coercions
applied). Failure -> `BadRequestError` with code `VALIDATION_ERROR`.

### Errors

Throw `AppError` subclasses (`BadRequestError`, `UnauthorizedError`, `ForbiddenError`,
`NotFoundError`, `ConflictError`) from services and guards. `AllExceptionsFilter`
renders them as `{ error, code }` with the right status. Unknown routes become
`404 ROUTE_NOT_FOUND`; unexpected errors become `500 INTERNAL_ERROR` (message hidden
in production).

### JWT

`TokenService` (`security/token.service.ts`) wraps `@nestjs/jwt`'s `JwtService`. Access
and refresh tokens are signed with different secrets (`JWT_ACCESS_SECRET` /
`JWT_REFRESH_SECRET`), and `JwtModule` is registered with no defaults: **the secret,
issuer and expiry are passed on every `sign()`/`verify()` call**, so a call site
can't silently fall back to a missing default. Verification also pins
`algorithms: ["HS256"]` and checks the issuer.

`decodeExpiry()` reads the `exp` claim of a token just signed (stored as the refresh
token's `expiresAt`).

If a test needs an expired token, don't forge one — log in normally, then move the
clock: `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(...)` (see
`tests/auth.test.ts`).

### Passwords

Argon2id via `@node-rs/argon2`, wrapped in `lib/password.ts`:

```ts
hashPassword(plain: string): Promise<string>
verifyPassword(storedHash: string, plainText: string): Promise<boolean>
```

Note the argument order on `verifyPassword`: `(storedHash, plainText)`, matching the
underlying `argon2.verify(hash, password)` convention — the opposite order from
`bcrypt.compare(plain, hash)`. Don't flip it back.

## Real-time layer (`modules/ops/`)

Two independent transports, both framed with the same `Envelope<T>` shape
(`type`, `id`, `ts`, `seq`, `payload`) so replay/ordering is checked
identically on both sides:

- **`AgentGateway`** — raw `ws` on `/agent-ws`. Machine agents connect with
  `?machineId&token`. Per-connection `SeqGuard` rejects a replayed/out-of-order
  `seq` or a `ts` more than 30s from server time. Connections are tracked in the
  injectable `MachineRegistry` (`machineId -> ws`).
- **`DashboardGateway`** — Socket.IO on `/dashboard-io`. Verifies
  `handshake.auth.token` with `TokenService.verifyAccessToken` (the same access token
  as the REST API), joins the caller's `branch:<branchId>` room (`hq` or a `null`
  branchId joins `branch:all`). Business logic pushes a `DashboardEvent` with
  `dashboardGateway.publishToBranch(branchId, event, payload)` — inject
  `DashboardGateway` (exported by `OpsModule`).

Why these are plain providers and not `@WebSocketGateway` classes: Nest supports one
WebSocket adapter per app, and this project needs two different transports. Each
gateway attaches to the HTTP server in `onModuleInit` (the agent one handles the
`upgrade` event for its own path; Socket.IO attaches itself) and cleans up in
`onModuleDestroy`.

Neither gateway touches the database yet — when one needs to, it gets its own
`ops.repository.ts` per the module DB privacy rule above.

The agent gateway's `verifyStation()` is a stub: it only checks that
`machineId`/`token` are present, not that they're valid against
`Machine.agentPublicKey`. See `modules/ops/REALTIME.md`.

## Testing

**All tests live in `tests/`, one folder, run with `npm test` (Vitest).** No
per-module `*.spec.ts` files, no second test runner, no real database.

`tests/helpers/app.ts` builds the real `AppModule` with `@nestjs/testing`, overriding
`PrismaService` with an in-memory fake (`tests/helpers/fake-prisma.ts`, one shared
instance in `tests/helpers/db.ts`, wiped before every test by `tests/setup.ts`).
It applies the same `configureApp()` as `main.ts`, so prefix, filter and helmet are
identical to production.

- `tests/rbac.test.ts` — `checkScope`/`checkAnyScope` in isolation.
- `tests/auth.test.ts` — login, token claims/expiry (via `vi.useFakeTimers`),
  refresh rotation + reuse detection, logout, suspended accounts, audit log.
- `tests/users.test.ts` — signup, role-escalation rules, cross-branch blocking.
- `tests/agent-gateway.test.ts` / `tests/dashboard-gateway.test.ts` — real `ws`
  / `socket.io-client` connections against a real listening app on an
  ephemeral port (`startTestServer()`).
- `tests/deny-by-default.test.ts` — `DenyByDefaultGuard` against a throwaway
  controller (AppModule's own routes are all already decorated, so this is
  the only way to prove an undecorated route is rejected).

Helpers: `buildTestApp()` (HTTP via `app.inject()`), `startTestServer()` (real port),
`seedUser()`, `loginAs()`, `setupWorld()` (one logged-in user per role/branch),
`tokensOf(app)` (the app's `TokenService`) — reuse these instead of re-deriving
fixtures in a new test file.

Run: `npm test` (once) or `npm run test:watch` (watch mode).

## Do / Don't when developing here

**Do:**
- Put a new feature under `src/modules/<name>/`, following the
  module/repository/schemas/service/controller shape, and add it to `AppModule`.
- Use `@Inject(Class)` on every constructor parameter (see above).
- Give every module its own `<name>.repository.ts` and route all DB access
  through it.
- Protect routes with `@Auth` / `@RequireScope` / `@AllowAny`, or mark them
  `@Public()` if they genuinely need no auth — `DenyByDefaultGuard` rejects
  anything with none of the four.
- Validate input with `ZodValidationPipe`; throw `AppError` subclasses.
- Add cross-module Zod/types to `shared/` only when more than one module
  genuinely needs them.
- Use relative imports (`../../common/...`) everywhere — `tsconfig.json` has no
  `baseUrl`/`paths`, so `@/*`-style imports will not resolve.
- Add new tests to `tests/`, named after what they cover
  (`<subject>.test.ts`), using Vitest's `test`/`expect`/`vi`.
- Run `npm test` and `npx tsc --noEmit` before considering a change done.

**Don't:**
- Don't inject `PrismaService` outside a module's own `<name>.repository.ts`
  (exception: `FreshAuthGuard`, grandfathered — don't extend that pattern).
- Don't rely on implicit constructor injection (missing `@Inject`) — it breaks
  under tsx and Vitest.
- Don't add `@Auth()` on top of `@RequireScope()`/`@AllowAny()` — they already
  authenticate. And don't stack extra `@UseGuards(...)` around them without checking
  the order: guards run in the order they are listed, and a scope check must come
  after authentication.
- Don't put a feature-specific Zod schema in `shared/schemas/` — it belongs in
  the module that owns it.
- Don't hardcode a role/permission check — import `Scope`/`SCOPE_RANK`/
  `ROLE_SCOPE` from `shared/types/auth.ts`.
- Don't add a second test folder or a second test runner — everything goes
  through Vitest in `tests/`.
- Don't call `jwt.sign()`/`verify()` yourself — go through `TokenService`.
- Don't use bcrypt-style `(plain, hash)` argument order on `verifyPassword`
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

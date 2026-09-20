# cstam-identity-service — Member A: Auth + RBAC (Fastify + JWT)

Implements the `identity/` slice of Step 0's frozen contract: login/refresh/logout/me,
user + employee creation, role updates, and the **shared RBAC middleware** that B
(`wallet/` + `session/`) and C (`station/` + `ops/`) should import as-is rather than
reimplement.

## What's here

```
prisma/schema.prisma        # your V4 schema + 2 additions (see below)
prisma/seed.ts               # bootstraps one hq ADMIN account
src/config/env.ts            # typed env loader
src/lib/
  prisma.ts                  # PrismaClient singleton
  password.ts                # bcrypt hash/verify
  jwt.ts                     # @fastify/jwt setup (access + refresh namespaces), sign/verify helpers
  app-error.ts                # AppError + subclasses -> {error, code} + status
src/shared/
  types/auth.ts               # Scope, SCOPE_RANK, ROLE_SCOPE, JWT claim shapes
  types/fastify.d.ts           # req.auth typing
  schemas/*.schemas.ts         # Zod request schemas (single source of truth)
src/middleware/                # Fastify preHandler hooks (file names kept for stable imports)
  validate.middleware.ts       # generic Zod body/params/query validator
  auth.middleware.ts           # authenticate / authenticateFresh
  rbac.middleware.ts           # requireScope / allowAny  <-- the RBAC gate
  error.middleware.ts          # setErrorHandler / setNotFoundHandler
src/modules/identity/
  auth.{service,controller,routes}.ts   # routes are Fastify plugins
  users.{service,controller,routes}.ts
src/routes/index.ts            # plugin mounting everything under /api/v1
src/app.ts, src/server.ts
```

## Two additions to your `schema.prisma`

Auth needs somewhere to store a password and to track refresh-token
sessions for logout/rotation, neither of which existed in V4:

1. **`User.passwordHash`** — new required `String` field.
2. **`RefreshToken` model** — `{ jti, userId, revoked, replacedByJti, expiresAt }`,
   one row per issued refresh token. `/auth/logout` revokes by `jti`;
   `/auth/refresh` rotates (marks the old row revoked, links it to the new one).
   This is what lets you invalidate *one* device's session without logging
   everyone out (ADR-003).

Everything else in the schema is untouched. Diff is isolated to the `User` model
and one new model, so it shouldn't conflict with B/C's work on the rest of V4.

> **Assumption flagged for review:** the contract's JWT claims include
> `branchId`, but V4 only has `EmployeeProfile.managedBranchId` (nullable,
> presumably manager-only). I used it as *the* branch for both EMPLOYEE and
> MANAGER accounts — i.e. `POST /employees` writes the assigned branch there
> regardless of role. If `branch_id` semantics get finalized differently
> (it's flagged parked in Step 0), this is the one place to revisit.

## The scope model (ADR-002)

```
public (0) < self (1) < staff (2) < admin (3) < hq (4)
```

| UserRole | Scope   |
|----------|---------|
| GAMER    | self    |
| EMPLOYEE | staff   |
| MANAGER  | admin   |
| ADMIN    | hq      |

`src/shared/types/auth.ts` is the single source of truth for this mapping —
import `Scope`, `SCOPE_RANK`, `ROLE_SCOPE` from there rather than hardcoding
role checks anywhere else in the codebase.

## Using the RBAC hooks in B's / C's routes

Hooks are plain async functions used in a route's `preHandler` array. Order matters — they run left to right.

```ts
import { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/auth.middleware";
import { requireScope } from "../../middleware/rbac.middleware";
import { validate } from "../../middleware/validate.middleware";

export async function walletRoutes(app: FastifyInstance) {
  // staff/self: a gamer can top up their own wallet; any staff can do it for them
  app.post("/wallet/:id/topup", {
    preHandler: [authenticate, requireScope("self", { ownerParam: "id" }), validate(topupSchema)],
  }, topupHandler);

  // admin(branch): only a branch's own MANAGER (or hq) can approve a station enrollment.
  // resolveBranchId may be async.
  app.post("/enrollment/:machineId/approve", {
    preHandler: [
      authenticate,
      requireScope("admin", {
        resolveBranchId: async (req) => getMachineBranch((req.params as { machineId: string }).machineId),
      }),
    ],
  }, approveHandler);
}
```

Register your plugin in `src/routes/index.ts` with `app.register(walletRoutes)`.

`requireScope(min, opts)`:
- **rank check** — caller's scope must be `>= min` (hq passes everything).
- **`ownerParam` / `ownerBody`** — only enforced when the caller's *actual*
  scope is exactly `self`; makes "self/staff"-style endpoints work in one
  line instead of writing an if/else per route.
- **`branchParam` / `resolveBranchId`** — only enforced for `staff`/`admin`
  callers (not `hq`, not `self`); makes "staff(branch)"/"admin(branch)"
  endpoints reject cross-branch access automatically.

Every route still re-validates ownership/branch-membership again wherever the
service logic depends on data the middleware can't see cheaply (e.g. "does
this session belong to this user's branch") — the contract's "every powerful
action re-checked server-side" applies at both layers.

## Endpoints implemented (identity/ slice of the contract)

| Method / Path | Scope | Notes |
|---|---|---|
| `POST /auth/login` | public | `{username,password}` → `{accessToken,refreshToken,user}` |
| `POST /auth/refresh` | public | rotates the refresh token, revokes the old one |
| `POST /auth/logout` | self | revokes one refresh-token session by `jti` |
| `GET /auth/me` | self | `{user:{id,role,branchId}}` |
| `POST /users` | public/staff | creates a GAMER account |
| `POST /employees` | admin/hq | creates EMPLOYEE/MANAGER; MANAGER can't create MANAGERs or cross-branch |
| `PATCH /users/:id/role` | admin/hq | MANAGER can't grant MANAGER/ADMIN or touch other branches |
| `GET /users/:id` | self/staff | |

## Running it

```bash
cp .env.example .env      # fill in DATABASE_URL and real JWT secrets
npm install               # package-lock.json was removed during the Fastify migration; this regenerates it
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed       # creates one hq ADMIN — SEED_ADMIN_USERNAME/PASSWORD env vars, or defaults
npm run dev                # http://localhost:4000/api/v1
```

## Not in this slice

- `membership/` module (also Member A's, per Step 0 §5's split) — not built here,
  scope was auth + RBAC only per this request.
- Station credential auth for the `/agent-ws` channel (ADR-003: "MAC is not
  auth") is a separate, non-JWT auth path that's C's `agent-gateway` concern —
  `authenticate`/`requireScope` here are for user-facing REST + `/dashboard-io` only.

## JWT setup (Fastify)

`@fastify/jwt` is registered twice in `src/lib/jwt.ts`, under the `access` and `refresh`
namespaces, each with its own secret (`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`), issuer and TTL.
Claims, refresh-token rotation and revocation are unchanged from the Express version.

## Testing

**Automated tests (no database needed)** — Vitest drives the real Fastify app through
`app.inject()`, with Prisma swapped for an in-memory fake (`tests/helpers/fake-prisma.ts`).

```bash
npm install
npx prisma generate     # needed once: the code imports the generated UserRole enum
npm test                # or: npm run test:watch
```

| File | Covers |
|---|---|
| `tests/rbac.test.ts` | `requireScope` / `allowAny` in isolation: rank, ownership, branch, hq bypass, async resolver |
| `tests/auth.test.ts` | login, token claims, expiry/tampering, refresh rotation + reuse detection, logout, suspended accounts, audit log |
| `tests/users.test.ts` | signup, role-escalation rules, cross-branch blocking, `/employees`, `/users/:id/role`, `/users/:id` |

**Manual / demo testing against a real DB** — start the server (`npm run dev`) and open
`requests.http` (VS Code "REST Client" extension). It walks login → gamer signup → 403 → admin
creates a manager → role change → refresh → logout.

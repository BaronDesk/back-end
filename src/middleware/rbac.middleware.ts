import { FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../lib/app-error";
import { Scope, SCOPE_RANK } from "../shared/types/auth";

type Bag = Record<string, unknown> | undefined;

/**
 * requireScope(min) — the workhorse RBAC gate (Fastify `preHandler` hook).
 *
 * Scopes are ranked public < self < staff < admin < hq. A caller passes if
 * their scope rank is >= the route's minimum. `hq` always passes everything
 * below it (it's the global admin/ADMIN role).
 *
 * Two optional extras encode the "(branch)" and "self" qualifiers from the
 * contract table, since a bare rank check isn't enough on its own:
 *
 *  - `ownerParam` / `ownerBody`: a caller whose *actual* scope is exactly
 *    `self` must additionally own the resource (their id must match this
 *    param/body field). Callers with a higher scope (staff+) skip the check —
 *    that's what lets staff act on a gamer's behalf.
 *
 *  - `branchParam` / `resolveBranchId`: a caller whose scope is `staff` or
 *    `admin` must additionally be acting within their own branchId. `hq`
 *    callers bypass this (global reach); a bare `self` caller has no branchId,
 *    so this is a no-op for them. `resolveBranchId` may be async (e.g. to look
 *    up the branch of a machine/session by id).
 *
 * Every powerful action is still re-checked server-side per the contract —
 * this hook is that check, not a substitute for it in service logic where
 * extra invariants apply.
 */
export function requireScope(
  min: Scope,
  opts: {
    ownerParam?: string;
    ownerBody?: string;
    branchParam?: string;
    resolveBranchId?: (req: FastifyRequest) => string | undefined | Promise<string | undefined>;
  } = {}
) {
  return async (req: FastifyRequest): Promise<void> => {
    const auth = req.auth;
    if (!auth) throw new UnauthorizedError();

    if (SCOPE_RANK[auth.scope] < SCOPE_RANK[min]) {
      throw new ForbiddenError();
    }

    const params = req.params as Bag;
    const body = req.body as Bag;
    const query = req.query as Bag;

    // Ownership check — only binds callers whose scope is exactly `self`.
    if (auth.scope === "self" && (opts.ownerParam || opts.ownerBody)) {
      const ownerId =
        (opts.ownerParam && params?.[opts.ownerParam]) ||
        (opts.ownerBody && body?.[opts.ownerBody]);
      if (ownerId !== auth.sub) {
        throw new ForbiddenError("You may only act on your own resources");
      }
    }

    // Branch check — binds `staff` and `admin`, not `hq` (global) or `self`
    // (no branch of their own).
    if ((auth.scope === "staff" || auth.scope === "admin") && (opts.branchParam || opts.resolveBranchId)) {
      const targetBranchId = opts.resolveBranchId
        ? await opts.resolveBranchId(req)
        : opts.branchParam
        ? params?.[opts.branchParam] ?? body?.[opts.branchParam] ?? query?.[opts.branchParam]
        : undefined;

      if (!targetBranchId || targetBranchId !== auth.branchId) {
        throw new ForbiddenError("You may only act within your own branch");
      }
    }
  };
}

/**
 * allowAny(...scopes) — for endpoints whose allowed set isn't a clean
 * "minimum rank" (e.g. an action open only to `self` and `hq`).
 */
export function allowAny(...scopes: Scope[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const auth = req.auth;
    if (!auth) throw new UnauthorizedError();
    if (!scopes.includes(auth.scope)) throw new ForbiddenError();
  };
}

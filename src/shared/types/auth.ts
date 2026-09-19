import { UserRole } from "@prisma/client";

/**
 * Auth scopes per ADR-002 (roles × scope):
 *   public          — no auth required
 *   self            — the authenticated user acting on their own resources
 *   staff(branch)   — an EMPLOYEE acting within their own branch
 *   admin(branch)   — a MANAGER acting within their own branch
 *   hq(global)      — an ADMIN acting across all branches
 *
 * This is the single source of truth for the scope hierarchy. Both the API
 * layer and any client-side authorization checks should import from here
 * rather than re-deriving the mapping.
 */
export type Scope = "public" | "self" | "staff" | "admin" | "hq";

export const SCOPE_RANK: Record<Scope, number> = {
  public: 0,
  self: 1,
  staff: 2,
  admin: 3,
  hq: 4,
};

/** Every UserRole maps to exactly one scope. */
export const ROLE_SCOPE: Record<UserRole, Scope> = {
  GAMER: "self",
  EMPLOYEE: "staff",
  MANAGER: "admin",
  ADMIN: "hq",
};

/**
 * JWT claims shape (Step 0 §4). `branchId` is null for GAMER and ADMIN
 * (global) accounts, and set for EMPLOYEE/MANAGER accounts tied to a branch.
 */
export interface AccessTokenClaims {
  sub: string; // user id
  role: UserRole;
  scope: Scope;
  branchId: string | null;
  jti: string;
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

/** What downstream middleware/handlers see on `req.auth` after authentication. */
export interface AuthContext {
  sub: string;
  role: UserRole;
  scope: Scope;
  branchId: string | null;
  jti: string;
}

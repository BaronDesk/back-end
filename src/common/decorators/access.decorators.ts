import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../guards/auth.guard";
import { FreshAuthGuard } from "../guards/fresh-auth.guard";
import { ACCESS_RULE_KEY, AccessRule, ScopeGuard } from "../guards/scope.guard";
import { ScopeOptions } from "../rbac/scope-rules";
import { Scope } from "../../shared/types/auth";

interface FreshOption {
  /** Re-check the account against the DB instead of trusting the JWT alone. */
  fresh?: boolean;
}

/**
 * The route needs an authenticated caller (any scope).
 *
 *   @Auth()
 *   @Auth({ fresh: true })   // also re-checks accountStatus in the DB
 */
export function Auth(opts: FreshOption = {}) {
  return applyDecorators(UseGuards(opts.fresh ? FreshAuthGuard : AuthGuard));
}

/**
 * The workhorse RBAC gate: authenticates, then requires the caller's scope to
 * be >= `min` (hq passes everything). Already includes authentication — do NOT
 * also add `@Auth()`.
 *
 *   @RequireScope("self", { ownerParam: "id" })
 *   @RequireScope("admin", { resolveBranchId: (req) => req.body?.branchId })
 *
 * See `checkScope` in `common/rbac/scope-rules.ts` for the ownership and
 * branch options.
 */
export function RequireScope(min: Scope, opts: ScopeOptions & FreshOption = {}) {
  const { fresh, ...scopeOpts } = opts;
  const rule: AccessRule = { kind: "min", min, opts: scopeOpts };
  return applyDecorators(
    SetMetadata(ACCESS_RULE_KEY, rule),
    UseGuards(fresh ? FreshAuthGuard : AuthGuard, ScopeGuard)
  );
}

/**
 * For endpoints whose allowed set isn't a clean "minimum rank" (e.g. only
 * `self` and `hq`). Authenticates too — don't add `@Auth()`.
 *
 *   @AllowAny("self", "hq")
 */
export function AllowAny(...scopes: Scope[]) {
  const rule: AccessRule = { kind: "any", scopes };
  return applyDecorators(SetMetadata(ACCESS_RULE_KEY, rule), UseGuards(AuthGuard, ScopeGuard));
}

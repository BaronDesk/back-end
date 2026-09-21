import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ForbiddenError } from "../../lib/app-error";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AUTHENTICATED_KEY } from "../decorators/access.decorators";
import { ACCESS_RULE_KEY } from "./scope.guard";

/**
 * Global safety net, registered once in `app.module.ts` (`APP_GUARD`) so it
 * runs on every route without anyone having to remember to add it.
 *
 * Every other guard here is opt-in per route (`@Auth()` / `@RequireScope()` /
 * `@AllowAny()`), which means a route with no decorator at all was silently
 * public. This guard closes that gap: it does not perform authentication or
 * authorization itself (that's still `AuthGuard`/`FreshAuthGuard`/`ScopeGuard`,
 * unchanged) — it only checks that the route carries *some* access-policy
 * marker (`@Public()`, `@Auth()`, `@RequireScope()`, or `@AllowAny()`) and
 * rejects the request if none is present.
 */
@Injectable()
export class DenyByDefaultGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    if (isPublic) return true;

    const isAuthenticated = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets);
    if (isAuthenticated) return true;

    const hasScopeRule = this.reflector.getAllAndOverride(ACCESS_RULE_KEY, targets) !== undefined;
    if (hasScopeRule) return true;

    throw new ForbiddenError(
      "Route declares no access policy — add @Public(), @Auth(), @RequireScope() or @AllowAny()",
      "NO_ACCESS_POLICY"
    );
  }
}

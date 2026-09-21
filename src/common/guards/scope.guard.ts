import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { checkAnyScope, checkScope, ScopeOptions } from "../rbac/scope-rules";
import { Scope } from "../../shared/types/auth";

export const ACCESS_RULE_KEY = "cstam:access-rule";

export type AccessRule =
  | { kind: "min"; min: Scope; opts: ScopeOptions }
  | { kind: "any"; scopes: Scope[] };

/**
 * Enforces the rule attached by `@RequireScope()` / `@AllowAny()`. Always used
 * after an auth guard (the decorators wire that order for you).
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<AccessRule | undefined>(ACCESS_RULE_KEY, context.getHandler());
    if (!rule) {
      // Fail closed: this guard is only ever attached together with a rule.
      throw new Error("ScopeGuard used without an access rule — use @RequireScope() or @AllowAny()");
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (rule.kind === "min") {
      await checkScope(req, rule.min, rule.opts);
    } else {
      await checkAnyScope(req, rule.scopes);
    }
    return true;
  }
}

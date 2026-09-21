import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { TokenService } from "../../security/token.service";

/**
 * Verifies `Authorization: Bearer <accessToken>` and attaches the decoded
 * claims to `req.auth`. Does not hit the DB — the JWT itself is the source of
 * truth for the request's identity/role/scope/branch, keeping the hot path
 * cheap. Use it through `@Auth()` / `@RequireScope()` / `@AllowAny()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    req.auth = this.tokens.authContextFromHeader(req.headers.authorization);
    return true;
  }
}

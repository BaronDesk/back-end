import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../../lib/app-error";
import { AuthContext } from "../../shared/types/auth";

/**
 * The authenticated caller (`req.auth`), for handlers behind `@Auth()`,
 * `@RequireScope()` or `@AllowAny()`.
 *
 *   me(@CurrentAuth() auth: AuthContext) { ... }
 */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().auth;
  if (!auth) throw new UnauthorizedError();
  return auth;
});

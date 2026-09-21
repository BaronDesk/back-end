import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../../lib/app-error";
import { PrismaService } from "../../prisma/prisma.service";
import { TokenService } from "../../security/token.service";

/**
 * Like `AuthGuard`, but re-checks the account against the DB and rejects
 * suspended/deleted/inactive accounts. Use on sensitive, low-traffic
 * endpoints (e.g. issuing new employee credentials) via `@Auth({ fresh: true })`.
 *
 * Grandfathered exception to the "module DB privacy" rule (ARCHITECTURE.md):
 * shared infrastructure, not a module, so it queries `user` directly. Don't
 * use it as precedent for a module to inject PrismaService itself.
 */
@Injectable()
export class FreshAuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = this.tokens.authContextFromHeader(req.headers.authorization);
    req.auth = auth;

    const user = await this.prisma.user.findUnique({
      where: { id: auth.sub },
      select: { accountStatus: true },
    });

    if (!user || user.accountStatus !== "ACTIVE") {
      throw new UnauthorizedError("Account is not active", "ACCOUNT_INACTIVE");
    }
    return true;
  }
}

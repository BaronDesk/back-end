import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { SCOPES_KEY, ScopeOptions } from '../decorators/scopes.decorator.js';
import { AuthContext, Scope, SCOPE_RANK } from '../auth/scope.js';

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const meta = this.reflector.get<({ min: Scope } & ScopeOptions) | undefined>(SCOPES_KEY, ctx.getHandler());
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthContext }>();
    const auth = req.user;
    if (!auth) throw new UnauthorizedException();
    if (SCOPE_RANK[auth.scope] < SCOPE_RANK[meta.min]) throw new ForbiddenException();

    const params = req.params as Record<string, string> | undefined;
    const body = req.body as Record<string, unknown> | undefined;

    if (auth.scope === 'self' && meta.ownerParam) {
      if (params?.[meta.ownerParam] !== auth.sub) throw new ForbiddenException('You may only act on your own resources');
    }
    if ((auth.scope === 'staff' || auth.scope === 'admin') && meta.branchParam) {
      const targetBranchId = params?.[meta.branchParam] ?? (body?.[meta.branchParam] as string | undefined);
      if (!targetBranchId || targetBranchId !== auth.branchId) throw new ForbiddenException('You may only act within your own branch');
    }
    return true;
  }
}

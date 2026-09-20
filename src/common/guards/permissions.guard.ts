import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator.js';
import { REQUIRE_SCOPE_KEY } from '../decorators/require-scope.decorator.js';
import type { AccessTokenPayload } from '../types/jwt-payload.js';
import { SCOPE_RANK, type Role, type Scope } from '../utils/scope.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredScope = this.reflector.getAllAndOverride<Scope | undefined>(REQUIRE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Deny by default: a route with no declared policy is unreachable.
    if (!requiredScope && !requiredRoles) {
      throw new ForbiddenException({ code: 'NO_ACCESS_POLICY', error: 'route declares no access policy' });
    }

    const request = context.switchToHttp().getRequest();
    const user: AccessTokenPayload | undefined = request.user;
    if (!user) {
      throw new ForbiddenException({ code: 'FORBIDDEN', error: 'not authenticated' });
    }

    if (requiredScope && SCOPE_RANK[user.scope] < SCOPE_RANK[requiredScope]) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_SCOPE',
        error: `requires ${requiredScope} scope`,
      });
    }

    if (requiredRoles && !requiredRoles.includes(user.role)) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ROLE',
        error: `requires one of roles: ${requiredRoles.join(', ')}`,
      });
    }

    return true;
  }
}

import { ForbiddenException } from '@nestjs/common';

import type { AccessTokenPayload } from '../types/jwt-payload.js';

export interface ScopeTarget {
  userId?: string;
  branchId?: string | null;
}

/**
 * Fine-grained authorization check, run inside a service after the coarse
 * guard already confirmed the caller meets the route's minimum scope rank.
 */
export function assertScope(caller: AccessTokenPayload, target: ScopeTarget): void {
  if (caller.scope === 'hq') return;

  if (caller.scope === 'self') {
    if (target.userId && target.userId !== caller.sub) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_SELF_ONLY',
        error: 'can only act on own resource',
      });
    }
    return;
  }

  if (target.branchId != null && target.branchId !== caller.branchId) {
    throw new ForbiddenException({
      code: 'FORBIDDEN_CROSS_BRANCH',
      error: 'cross-branch access denied',
    });
  }
}

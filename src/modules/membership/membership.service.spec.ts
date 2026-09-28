import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { MembershipService } from './membership.service.js';

describe('MembershipService', () => {
  const caller: AccessTokenPayload = {
    sub: 'user-1',
    role: 'GAMER',
    scope: 'self',
    branchId: null,
    jti: 'token-1',
  };
  let repository: {
    findGamerProfileIdByUserId: ReturnType<typeof vi.fn>;
    purchase: ReturnType<typeof vi.fn>;
  };
  let service: MembershipService;

  beforeEach(() => {
    repository = {
      findGamerProfileIdByUserId: vi.fn().mockResolvedValue('gamer-1'),
      purchase: vi
        .fn()
        .mockResolvedValue({ id: 'membership-1', membershipPlanId: 'plan-1' }),
    };
    service = new MembershipService(repository as any);
  });

  it('purchases a plan for the caller’s gamer profile with the supplied idempotency key', async () => {
    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(repository.findGamerProfileIdByUserId).toHaveBeenCalledWith(
      'user-1',
    );
    expect(repository.purchase).toHaveBeenCalledWith(
      'gamer-1',
      'plan-1',
      'purchase-123',
    );
    expect(result).toMatchObject({
      id: 'membership-1',
      membershipPlanId: 'plan-1',
    });
  });
});

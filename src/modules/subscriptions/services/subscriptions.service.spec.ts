import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { SubscriptionsService } from './subscriptions.service.js';

describe('SubscriptionsService', () => {
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
  let service: SubscriptionsService;

  beforeEach(() => {
    repository = {
      findGamerProfileIdByUserId: vi.fn().mockResolvedValue('gamer-1'),
      purchase: vi
        .fn()
        .mockResolvedValue({
          id: 'subscription-1',
          subscriptionPlanId: 'plan-1',
        }),
    };
    service = new SubscriptionsService(repository as any);
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
      id: 'subscription-1',
      subscriptionPlanId: 'plan-1',
    });
  });
});

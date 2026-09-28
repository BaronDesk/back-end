import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { SubscriptionsService } from './subscriptions.service.js';

describe('SubscriptionsService.purchase', () => {
  const caller: AccessTokenPayload = {
    sub: 'user-1',
    role: 'GAMER',
    scope: 'self',
    branchId: null,
    jti: 'token-1',
  };
  const plan = {
    id: 'plan-1',
    price: new Prisma.Decimal('20'),
    durationDays: 7,
    benefits: { windows: [] },
  };
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let wallet: { debit: ReturnType<typeof vi.fn>; credit: ReturnType<typeof vi.fn> };
  let service: SubscriptionsService;

  beforeEach(() => {
    repository = {
      findGamerProfileIdByUserId: vi.fn().mockResolvedValue('gamer-1'),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      findPlan: vi.fn().mockResolvedValue(plan),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'subscription-1', subscriptionPlanId: 'plan-1' }),
    };
    wallet = {
      debit: vi.fn().mockResolvedValue({ id: 'entry-1' }),
      credit: vi.fn().mockResolvedValue({ id: 'entry-2' }),
    };
    service = new SubscriptionsService(repository as any, wallet as any);
  });

  it('debits the price through WalletService with a namespaced key, then creates the subscription', async () => {
    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', {
      amount: 2000,
      type: 'PAYMENT',
      idempotencyKey: 'subscription:purchase-123',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        gamerProfileId: 'gamer-1',
        subscriptionPlanId: 'plan-1',
        benefitsSnapshot: plan.benefits,
        idempotencyKey: 'purchase-123',
      }),
    );
    expect(result).toMatchObject({ id: 'subscription-1' });
  });

  it('allows several subscriptions per gamer (no one-active check)', async () => {
    await service.purchase(caller, 'plan-1', { idempotencyKey: 'a' });
    await service.purchase(caller, 'plan-1', { idempotencyKey: 'b' });

    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(wallet.debit).toHaveBeenCalledTimes(2);
  });

  it('propagates INSUFFICIENT_FUNDS from the wallet and never creates the subscription', async () => {
    wallet.debit.mockRejectedValue(
      new ConflictException({ code: 'INSUFFICIENT_FUNDS' }),
    );

    await expect(service.purchase(caller, 'plan-1', {})).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_FUNDS' },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refunds through WalletService when the subscription insert fails', async () => {
    const boom = new Error('db down');
    repository.create.mockRejectedValue(boom);

    await expect(
      service.purchase(caller, 'plan-1', { idempotencyKey: 'k1' }),
    ).rejects.toBe(boom);
    expect(wallet.credit).toHaveBeenCalledWith('gamer-1', {
      amount: 2000,
      type: 'REFUND',
      idempotencyKey: 'subscription:k1:refund',
    });
  });
});

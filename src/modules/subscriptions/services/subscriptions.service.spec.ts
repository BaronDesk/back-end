import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { SubscriptionsService } from './subscriptions.service.js';

const config = { get: (key: string) => ({ BUSINESS_TIMEZONE: 'Africa/Tunis' })[key] };

describe('SubscriptionsService.getWindowDiscountForGamer', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let service: SubscriptionsService;
  const nightOwl = { windows: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '06:00', discountPercent: 100 }] };
  const weekend = { windows: [{ daysOfWeek: [0, 6], startTime: '00:00', endTime: '00:00', discountPercent: 50 }] };

  beforeEach(() => {
    repository = {
      expireLapsed: vi.fn().mockResolvedValue({ count: 0 }),
      findActiveForGamer: vi.fn().mockResolvedValue([
        { id: 'owl', benefitsSnapshot: nightOwl },
        { id: 'wk', benefitsSnapshot: weekend },
        { id: 'legacy', benefitsSnapshot: { type: 'free_hours', hours: 15 } },
      ]),
    };
    service = new SubscriptionsService(repository as any, {} as any, config as any);
  });

  // Africa/Tunis is UTC+1 all year.
  it('gives the best window discount at that local time, and ignores benefits in an unknown shape', async () => {
    // Wed 2026-09-30 03:00 local: Night Owl only.
    await expect(service.getWindowDiscountForGamer('g1', new Date('2026-09-30T02:00:00Z'))).resolves.toEqual({ subscriptionId: 'owl', discountPercent: 100 });
    // Sat 2026-10-03 14:00 local: weekend only.
    await expect(service.getWindowDiscountForGamer('g1', new Date('2026-10-03T13:00:00Z'))).resolves.toEqual({ subscriptionId: 'wk', discountPercent: 50 });
    // Wed 14:00 local: no window.
    await expect(service.getWindowDiscountForGamer('g1', new Date('2026-09-30T13:00:00Z'))).resolves.toBeNull();
  });

  it('expires lapsed passes first', async () => {
    await service.getWindowDiscountForGamer('g1', new Date('2026-09-30T13:00:00Z'));
    expect(repository.expireLapsed).toHaveBeenCalledWith('g1', new Date('2026-09-30T00:00:00Z'));
  });
});

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
      expireLapsed: vi.fn().mockResolvedValue({ count: 0 }),
      findActiveForGamer: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'subscription-1', subscriptionPlanId: 'plan-1' }),
    };
    wallet = {
      debit: vi.fn().mockResolvedValue({ id: 'entry-1' }),
      credit: vi.fn().mockResolvedValue({ id: 'entry-2' }),
    };
    service = new SubscriptionsService(repository as any, wallet as any, config as any);
  });

  it('debits the price through WalletService with a namespaced key, then creates the subscription', async () => {
    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', {
      amount: 20000,
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

  it('allows several different passes, but not the same pass twice while it is active', async () => {
    repository.findActiveForGamer.mockResolvedValueOnce([{ id: 's0', subscriptionPlanId: 'other-plan' }]);
    await service.purchase(caller, 'plan-1', { idempotencyKey: 'a' });
    expect(repository.create).toHaveBeenCalledTimes(1);

    repository.findActiveForGamer.mockResolvedValueOnce([{ id: 's1', subscriptionPlanId: 'plan-1' }]);
    await expect(service.purchase(caller, 'plan-1', { idempotencyKey: 'b' })).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_ALREADY_ACTIVE' },
    });
    expect(wallet.debit).toHaveBeenCalledTimes(1);
    expect(repository.expireLapsed).toHaveBeenCalled();
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
      amount: 20000,
      type: 'REFUND',
      idempotencyKey: 'subscription:k1:refund',
    });
  });
});

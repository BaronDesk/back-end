import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { MembershipService } from './membership.service.js';

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('MembershipService.purchase', () => {
  const caller: AccessTokenPayload = {
    sub: 'user-1',
    role: 'GAMER',
    scope: 'self',
    branchId: null,
    jti: 'token-1',
  };
  const plan = {
    id: 'plan-1',
    price: 12500,
    durationDays: 30,
    discountPercent: new Prisma.Decimal('10'),
  };
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let wallet: { debit: ReturnType<typeof vi.fn>; credit: ReturnType<typeof vi.fn> };
  let service: MembershipService;

  beforeEach(() => {
    repository = {
      findGamerProfileIdByUserId: vi.fn().mockResolvedValue('gamer-1'),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      findPlan: vi.fn().mockResolvedValue(plan),
      expireLapsed: vi.fn().mockResolvedValue({ count: 0 }),
      findActiveForGamer: vi.fn().mockResolvedValue(null),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'membership-1', membershipPlanId: 'plan-1' }),
    };
    wallet = {
      debit: vi.fn().mockResolvedValue({ id: 'entry-1' }),
      credit: vi.fn().mockResolvedValue({ id: 'entry-2' }),
    };
    service = new MembershipService(repository as any, wallet as any, { record: vi.fn() } as any, { release: vi.fn(), save: vi.fn() } as any);
  });

  it('debits the price through WalletService with a namespaced key, then creates the membership', async () => {
    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', {
      amount: 12500,
      type: 'PAYMENT',
      idempotencyKey: 'membership:purchase-123',
    });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        gamerProfileId: 'gamer-1',
        membershipPlanId: 'plan-1',
        idempotencyKey: 'purchase-123',
      }),
    );
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'membership-1' });
  });

  it('replays a previous purchase with the same idempotency key without charging again', async () => {
    repository.findByIdempotencyKey.mockResolvedValue({ id: 'membership-0' });

    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(result).toEqual({ id: 'membership-0' });
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects the same or a cheaper tier with MEMBERSHIP_ALREADY_ACTIVE before charging', async () => {
    repository.findActiveForGamer.mockResolvedValue({
      id: 'membership-0',
      endDate: new Date(Date.now() + 10 * 86_400_000),
      membershipPlan: { price: 12500, durationDays: 30 },
    });

    await expect(service.purchase(caller, 'plan-1', {})).rejects.toMatchObject({
      response: { code: 'MEMBERSHIP_ALREADY_ACTIVE' },
    });
    expect(repository.expireLapsed).toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('upgrades to a dearer tier: pays the difference minus what is left of the old one, and cancels it', async () => {
    const endDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 15 * 86_400_000);
    repository.findActiveForGamer.mockResolvedValue({
      id: 'membership-0',
      endDate,
      membershipPlan: { price: 10000, durationDays: 30 },
    });
    repository.setStatus = vi.fn().mockResolvedValue({});
    await service.purchase(caller, 'plan-1', { idempotencyKey: 'up-1' });
    // 12500 coins new, 15 of 30 days left of a 10000-coin tier = 5000 coins credit.
    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', expect.objectContaining({ amount: 7500 }));
    expect(repository.setStatus).toHaveBeenCalledWith('membership-0', 'CANCELLED');
    expect(repository.create).toHaveBeenCalled();
  });

  it('returns 404 for an unknown plan without charging', async () => {
    repository.findPlan.mockResolvedValue(null);

    await expect(service.purchase(caller, 'plan-x', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('propagates INSUFFICIENT_FUNDS from the wallet and never creates the membership', async () => {
    wallet.debit.mockRejectedValue(
      new ConflictException({ code: 'INSUFFICIENT_FUNDS' }),
    );

    await expect(service.purchase(caller, 'plan-1', {})).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_FUNDS' },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refunds through WalletService when the membership insert fails', async () => {
    const boom = new Error('db down');
    repository.create.mockRejectedValue(boom);

    await expect(
      service.purchase(caller, 'plan-1', { idempotencyKey: 'k1' }),
    ).rejects.toBe(boom);
    expect(wallet.credit).toHaveBeenCalledWith('gamer-1', {
      amount: 12500,
      type: 'REFUND',
      idempotencyKey: 'membership:k1:refund',
    });
  });

  it('refunds and reports MEMBERSHIP_ALREADY_ACTIVE when the partial unique index catches a race', async () => {
    repository.create.mockRejectedValue(uniqueViolation());

    await expect(service.purchase(caller, 'plan-1', {})).rejects.toMatchObject({
      response: { code: 'MEMBERSHIP_ALREADY_ACTIVE' },
    });
    expect(wallet.credit).toHaveBeenCalledTimes(1);
  });

  it('returns the winning row without refunding when a same-key retry raced the insert', async () => {
    repository.create.mockRejectedValue(uniqueViolation());
    repository.findByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'membership-1' });

    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'k1',
    });

    expect(result).toEqual({ id: 'membership-1' });
    expect(wallet.credit).not.toHaveBeenCalled();
  });

  it('skips the wallet entirely for a free plan', async () => {
    repository.findPlan.mockResolvedValue({ ...plan, price: 0 });

    await service.purchase(caller, 'plan-1', {});

    expect(wallet.debit).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalled();
  });
});

describe('MembershipService.getActiveDiscountForGamer / getBookingAdvanceDays', () => {
  let repository: { findActiveForGamer: ReturnType<typeof vi.fn>; expireLapsed: ReturnType<typeof vi.fn> };
  let service: MembershipService;

  beforeEach(() => {
    repository = { findActiveForGamer: vi.fn(), expireLapsed: vi.fn().mockResolvedValue({ count: 0 }) };
    service = new MembershipService(repository as any, {} as any, { record: vi.fn() } as any, { release: vi.fn(), save: vi.fn() } as any);
  });

  it('returns null when the gamer has no active membership', async () => {
    repository.findActiveForGamer.mockResolvedValue(null);
    await expect(service.getActiveDiscountForGamer('gamer-1')).resolves.toBeNull();
    expect(repository.findActiveForGamer).toHaveBeenCalledWith('gamer-1');
  });

  it('expires lapsed memberships (end date before today) before looking one up, so they give no discount', async () => {
    repository.findActiveForGamer.mockResolvedValue(null);
    await service.getActiveDiscountForGamer('gamer-1');
    const [gamer, today] = repository.expireLapsed.mock.calls[0];
    expect(gamer).toBe('gamer-1');
    expect(today.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(repository.expireLapsed.mock.invocationCallOrder[0]).toBeLessThan(repository.findActiveForGamer.mock.invocationCallOrder[0]);
  });

  it("books as far ahead as the plan allows, 0 days without a membership", async () => {
    repository.findActiveForGamer.mockResolvedValueOnce({ id: 'm', membershipPlan: { bookingAdvanceDays: 7 } });
    await expect(service.getBookingAdvanceDays('gamer-1')).resolves.toBe(7);
    repository.findActiveForGamer.mockResolvedValueOnce(null);
    await expect(service.getBookingAdvanceDays('gamer-1')).resolves.toBe(0);
  });

  it('returns the membership id and its snapshotted discount when one is active', async () => {
    repository.findActiveForGamer.mockResolvedValue({
      id: 'membership-9',
      discountPercentSnapshot: new Prisma.Decimal('15'),
    });
    await expect(service.getActiveDiscountForGamer('gamer-1')).resolves.toEqual({
      membershipId: 'membership-9',
      discountPercent: new Prisma.Decimal('15'),
    });
  });
});


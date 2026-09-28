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
    price: new Prisma.Decimal('12.50'),
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
    service = new MembershipService(repository as any, wallet as any);
  });

  it('debits the price through WalletService with a namespaced key, then creates the membership', async () => {
    const result = await service.purchase(caller, 'plan-1', {
      idempotencyKey: 'purchase-123',
    });

    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', {
      amount: 1250,
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

  it('rejects with MEMBERSHIP_ALREADY_ACTIVE before charging when the gamer already has one', async () => {
    repository.findActiveForGamer.mockResolvedValue({ id: 'membership-0' });

    await expect(service.purchase(caller, 'plan-1', {})).rejects.toMatchObject({
      response: { code: 'MEMBERSHIP_ALREADY_ACTIVE' },
    });
    expect(repository.expireLapsed).toHaveBeenCalled();
    expect(wallet.debit).not.toHaveBeenCalled();
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
      amount: 1250,
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
    repository.findPlan.mockResolvedValue({ ...plan, price: new Prisma.Decimal(0) });

    await service.purchase(caller, 'plan-1', {});

    expect(wallet.debit).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalled();
  });
});

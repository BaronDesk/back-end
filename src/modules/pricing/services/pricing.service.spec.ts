import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { PricingService } from './pricing.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'user-1', role: 'MANAGER', scope: 'admin', branchId: 'branch-a', jti: 'jti-1', ...overrides };
}

describe('PricingService', () => {
  let repo: { findByBranchId: ReturnType<typeof vi.fn>; upsertForBranch: ReturnType<typeof vi.fn> };
  let service: PricingService;

  const row = {
    id: 'pricing-1', branchId: 'branch-a',
    paygRate: 10000, bookingRate: 25000,
    updatedAt: new Date(),
  };

  beforeEach(() => {
    repo = { findByBranchId: vi.fn().mockResolvedValue(row), upsertForBranch: vi.fn().mockResolvedValue(row) };
    service = new PricingService(repo as any);
  });

  it('returns pricing for a manager reading their own branch', async () => {
    const result = await service.getForBranch('branch-a', caller());
    expect(result.paygRate).toBe(10000);
  });

  it('rejects a manager reading another branch', async () => {
    await expect(service.getForBranch('branch-b', caller())).rejects.toThrow(ForbiddenException);
  });

  it('lets hq read any branch', async () => {
    await expect(
      service.getForBranch('branch-z', caller({ role: 'ADMIN', scope: 'hq', branchId: null })),
    ).resolves.toBeDefined();
  });

  it('404s when no pricing row exists yet', async () => {
    repo.findByBranchId.mockResolvedValueOnce(null);
    await expect(service.getForBranch('branch-a', caller())).rejects.toThrow(NotFoundException);
  });

  it("upserts pricing for the caller's own branch", async () => {
    const result = await service.upsertForBranch('branch-a', { paygRate: 10000, bookingRate: 25000 }, caller());
    expect(repo.upsertForBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-a', paygRate: 10000, bookingRate: 25000 }),
    );
    expect(result.bookingRate).toBe(25000);
  });

  it("rejects a manager upserting another branch's pricing", async () => {
    await expect(
      service.upsertForBranch('branch-b', { paygRate: 10, bookingRate: 25 }, caller()),
    ).rejects.toThrow(ForbiddenException);
  });
});

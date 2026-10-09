import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PricingService } from './pricing.service.js';

describe('PricingService', () => {
  let repo: { find: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  let service: PricingService;

  const row = { id: 1, paygRate: 4000, bookingRate: 4000, createdAt: new Date(), updatedAt: new Date() };

  beforeEach(() => {
    repo = { find: vi.fn().mockResolvedValue(row), upsert: vi.fn().mockResolvedValue(row) };
    service = new PricingService(repo as any);
  });

  it('returns the price list', async () => {
    await expect(service.get()).resolves.toEqual({ paygRate: 4000, bookingRate: 4000, updatedAt: row.updatedAt });
  });

  it('404s with PRICING_NOT_SET before any price is set', async () => {
    repo.find.mockResolvedValue(null);
    await expect(service.get()).rejects.toMatchObject({ response: { code: 'PRICING_NOT_SET' } });
    await expect(service.getRates()).rejects.toMatchObject({ response: { code: 'PRICING_NOT_SET' } });
  });

  it('saves the rates', async () => {
    const result = await service.upsert({ paygRate: 4000, bookingRate: 4000 });
    expect(repo.upsert).toHaveBeenCalledWith({ paygRate: 4000, bookingRate: 4000 });
    expect(result.bookingRate).toBe(4000);
  });

  it('getRates returns the raw rates', async () => {
    await expect(service.getRates()).resolves.toEqual({ paygRate: 4000, bookingRate: 4000 });
  });
});

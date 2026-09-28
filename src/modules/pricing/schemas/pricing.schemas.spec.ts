import { describe, expect, it } from 'vitest';

import { upsertPricingSchema } from './pricing.schemas.js';

describe('pricing rates', () => {
  it('parses valid payg/booking rates', () => {
    const result = upsertPricingSchema.parse({ paygRate: 10000, bookingRate: 25000 });
    expect(result.paygRate).toBe(10000);
  });

  it.each([0, -5, NaN, 10.5, '12'])('rejects invalid rate %s', (paygRate) => {
    expect(upsertPricingSchema.safeParse({ paygRate, bookingRate: 8000 }).success).toBe(false);
  });
});

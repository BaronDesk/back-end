import { describe, expect, it } from 'vitest';

import { upsertPricingSchema } from './pricing.schemas.js';

describe('pricing rates', () => {
  it('parses valid payg/booking rates', () => {
    const result = upsertPricingSchema.parse({ paygRate: 4000, bookingRate: 4000 });
    expect(result.paygRate).toBe(4000);
  });

  it.each([0, -5, NaN, 10.5, '12'])('rejects invalid rate %s', (paygRate) => {
    expect(upsertPricingSchema.safeParse({ paygRate, bookingRate: 8000 }).success).toBe(false);
  });
});

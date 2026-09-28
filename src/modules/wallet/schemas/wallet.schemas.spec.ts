import { describe, expect, it } from 'vitest';

import { creditSchema } from './wallet.schemas.js';

describe('wallet movement amount', () => {
  it('parses a positive integer', () => {
    const result = creditSchema.parse({ amount: 15000 });
    expect(result.amount).toBe(15000);
    expect(typeof result.amount).toBe('number');
  });

  it.each([0, -5, 1.5, NaN, '15000'])('rejects %s', (amount) => {
    expect(creditSchema.safeParse({ amount }).success).toBe(false);
  });

  it('rejects amounts above 32-bit ceiling', () => {
    expect(creditSchema.safeParse({ amount: 2_147_483_648 }).success).toBe(false);
  });
});

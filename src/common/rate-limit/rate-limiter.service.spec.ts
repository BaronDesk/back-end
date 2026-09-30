import { beforeEach, describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limiter.service.js';

/** Just enough of ioredis for the limiter. */
function fakeRedis() {
  const store = new Map<string, number>();
  return {
    store,
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    incr: async (k: string) => {
      store.set(k, (store.get(k) ?? 0) + 1);
      return store.get(k)!;
    },
    expire: async () => 1,
    ttl: async () => 120,
    del: async (k: string) => Number(store.delete(k)),
  };
}

describe('RateLimiter', () => {
  const rule = { limit: 3, windowS: 60 };
  let redis: ReturnType<typeof fakeRedis>;
  let limiter: RateLimiter;

  beforeEach(() => {
    redis = fakeRedis();
    limiter = new RateLimiter(redis as any);
  });

  it('refuses with 429 once the limit is reached, and a reset clears it', async () => {
    for (let i = 0; i < 3; i++) await limiter.hit('login:ip:ali', rule);
    await expect(limiter.assertUnder('login:ip:ali', rule)).rejects.toMatchObject({ response: { code: 'TOO_MANY_ATTEMPTS' }, status: 429 });
    await limiter.reset('login:ip:ali');
    await expect(limiter.assertUnder('login:ip:ali', rule)).resolves.toBeUndefined();
  });

  it('consume counts and refuses past the limit', async () => {
    for (let i = 0; i < 3; i++) await limiter.consume('signup:ip', rule);
    await expect(limiter.consume('signup:ip', rule)).rejects.toMatchObject({ status: 429 });
  });

  it('lets requests through when Redis is down', async () => {
    const broken = new RateLimiter({ get: async () => { throw new Error('down'); }, incr: async () => { throw new Error('down'); } } as any);
    await expect(broken.assertUnder('k', rule)).resolves.toBeUndefined();
    await expect(broken.consume('k', rule)).resolves.toBeUndefined();
  });
});

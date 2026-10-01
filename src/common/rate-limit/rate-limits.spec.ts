import { describe, expect, it } from 'vitest';

import { authRateLimits } from './rate-limits.js';

describe('authRateLimits', () => {
  it('defaults to 10 login failures per 15 minutes, 60 refreshes a minute, 30 sign-ups an hour', () => {
    expect(authRateLimits(() => undefined)).toEqual({
      loginFailures: { limit: 10, windowS: 900 },
      refreshes: { limit: 60, windowS: 60 },
      signups: { limit: 30, windowS: 3600 },
    });
  });

  it('takes each count from the environment, keeping the windows', () => {
    const env: Record<string, unknown> = {
      RATE_LIMIT_LOGIN_FAILURES: 5,
      RATE_LIMIT_REFRESHES_PER_MINUTE: '120',
      RATE_LIMIT_SIGNUPS_PER_HOUR: 1000,
    };
    expect(authRateLimits((k) => env[k])).toEqual({
      loginFailures: { limit: 5, windowS: 900 },
      refreshes: { limit: 120, windowS: 60 },
      signups: { limit: 1000, windowS: 3600 },
    });
  });

  it('ignores a zero, negative or non-numeric value', () => {
    const env: Record<string, unknown> = { RATE_LIMIT_LOGIN_FAILURES: 0, RATE_LIMIT_REFRESHES_PER_MINUTE: -1, RATE_LIMIT_SIGNUPS_PER_HOUR: 'many' };
    expect(authRateLimits((k) => env[k])).toEqual(authRateLimits(() => undefined));
  });
});

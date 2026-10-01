import type { RateLimit } from './rate-limiter.service.js';

/** The rate limits of the public auth routes (A5). Each count comes from the environment, with these defaults. */
export interface AuthRateLimits {
  /** Wrong passwords per IP + username before login is refused for a while. */
  loginFailures: RateLimit;
  /** Refreshes per IP: a client refreshes every ~15 min, so this is generous. */
  refreshes: RateLimit;
  /** Sign-ups per IP: enough for a venue's shared Wi-Fi, not for a script. */
  signups: RateLimit;
}

/** `get` is `ConfigService.get`: a missing or invalid value falls back to the default. */
export function authRateLimits(get: (key: string) => unknown): AuthRateLimits {
  const count = (key: string, fallback: number) => {
    const value = Number(get(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    loginFailures: { limit: count('RATE_LIMIT_LOGIN_FAILURES', 10), windowS: 15 * 60 },
    refreshes: { limit: count('RATE_LIMIT_REFRESHES_PER_MINUTE', 60), windowS: 60 },
    signups: { limit: count('RATE_LIMIT_SIGNUPS_PER_HOUR', 30), windowS: 60 * 60 },
  };
}

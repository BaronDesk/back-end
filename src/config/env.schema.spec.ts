import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema.js';

const REQUIRED = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'access',
  JWT_REFRESH_SECRET: 'refresh',
};

describe('validateEnv station timing', () => {
  it('defaults to a 15 s heartbeat, a 60 s lease and a 10 s grace, with OFFLINE after 45 s', () => {
    expect(validateEnv(REQUIRED)).toMatchObject({
      STATION_HEARTBEAT_INTERVAL_S: 15,
      STATION_LEASE_S: 60,
      STATION_LEASE_GRACE_S: 10,
      PRESENCE_OFFLINE_AFTER_MS: 45_000,
    });
  });

  it('refuses to start when OFFLINE comes before 3 heartbeats', () => {
    expect(() => validateEnv({ ...REQUIRED, PRESENCE_OFFLINE_AFTER_MS: '44999' })).toThrow(/PRESENCE_OFFLINE_AFTER_MS/);
    expect(() => validateEnv({ ...REQUIRED, STATION_HEARTBEAT_INTERVAL_S: '20' })).toThrow(/3 x STATION_HEARTBEAT_INTERVAL_S/);
  });

  it('accepts exactly 3 heartbeats, and a sub-second heartbeat for fast test setups', () => {
    expect(() => validateEnv({ ...REQUIRED, STATION_HEARTBEAT_INTERVAL_S: '20', PRESENCE_OFFLINE_AFTER_MS: '60000' })).not.toThrow();
    expect(() => validateEnv({ ...REQUIRED, STATION_HEARTBEAT_INTERVAL_S: '0.5', PRESENCE_OFFLINE_AFTER_MS: '1500' })).not.toThrow();
  });
});

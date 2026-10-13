import { describe, expect, it } from 'vitest';

import { stationTiming } from './station-timing.js';

const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

describe('stationTiming', () => {
  it('defaults to a 15 s heartbeat, a 60 s lease and a 10 s grace', () => {
    expect(stationTiming(config({}))).toEqual({ heartbeatIntervalSeconds: 15, leaseSeconds: 60, leaseGraceSeconds: 10 });
  });

  it('grants the shorter of SESSION_LEASE_CAP_S and STATION_LEASE_S', () => {
    expect(stationTiming(config({ SESSION_LEASE_CAP_S: 180, STATION_LEASE_S: 60 })).leaseSeconds).toBe(60);
    expect(stationTiming(config({ SESSION_LEASE_CAP_S: 30, STATION_LEASE_S: 60 })).leaseSeconds).toBe(30);
  });
});

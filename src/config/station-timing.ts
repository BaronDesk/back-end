import type { ConfigService } from '@nestjs/config';

/**
 * Station timing, decided by the backend alone and sent to every station in
 * its policy (heartbeatIntervalSeconds / defaultLeaseDurationSeconds /
 * leaseGracePeriodSeconds) on each (re)connect. Not staff-editable.
 */
export interface StationTiming {
  /** How often the agent heartbeats. */
  heartbeatIntervalSeconds: number;
  /** The longest lease the backend grants, and the agent's own cap on any lease. */
  leaseSeconds: number;
  /** How long the agent keeps a lapsed lease before it locks. */
  leaseGraceSeconds: number;
}

/** The one place these settings are read: presence, the policy and session billing all use it. */
export function stationTiming(config: Pick<ConfigService, 'get'>): StationTiming {
  const leaseCap = Number(config.get('SESSION_LEASE_CAP_S') ?? 180);
  const stationLease = Number(config.get('STATION_LEASE_S') ?? 60);
  return {
    heartbeatIntervalSeconds: Number(config.get('STATION_HEARTBEAT_INTERVAL_S') ?? 15),
    leaseSeconds: Math.min(leaseCap, stationLease),
    leaseGraceSeconds: Number(config.get('STATION_LEASE_GRACE_S') ?? 10),
  };
}

import { z } from 'zod';

/**
 * The staff-editable station policy: a branch's default (Branch.stationPolicy)
 * and a station's own overrides (Machine.policy) take the same fields.
 */
export const stationPolicySchema = z.object({
  cpuTempAlertThreshold: z.number().positive().optional(),
  gpuTempAlertThreshold: z.number().positive().optional(),
  usbDebounceWindowSeconds: z.number().int().positive().optional(),
  telemetryCadenceSeconds: z.number().int().positive().optional(),
}).strict();
export type StationPolicy = z.infer<typeof stationPolicySchema>;

export const STATION_POLICY_FIELDS = Object.keys(stationPolicySchema.shape) as (keyof StationPolicy)[];

/**
 * What a station is sent in POLICY_UPDATE: its effective policy plus the
 * backend's timing (names the agent accepts). The timing is never staff-editable.
 */
export type EffectiveStationPolicy = StationPolicy & {
  heartbeatIntervalSeconds: number;
  defaultLeaseDurationSeconds: number;
  leaseGracePeriodSeconds: number;
};

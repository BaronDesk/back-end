import { z } from 'zod';

export const handshakePayloadSchema = z.object({
  serialNumber: z.string().trim().min(1),
  agentVersion: z.string().optional(),
  osVersion: z.string().optional(),
  machineName: z.string().optional(),
});
export type HandshakePayload = z.infer<typeof handshakePayloadSchema>;

export const heartbeatPayloadSchema = z.object({
  locked: z.boolean(),
  sessionId: z.string().nullish(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;

/** One watched device, as the agent reports it (always the full list). */
export const peripheralSchema = z.object({
  deviceId: z.string().min(1).max(512),
  name: z.string().max(256).nullish(),
  vendorProductId: z.string().max(128).nullish(),
  connected: z.boolean(),
  changedAt: z.string().max(64).nullish(),
});
export type Peripheral = z.infer<typeof peripheralSchema>;

/** peripheral_status: a full snapshot of the watched peripherals. */
export const peripheralStatusPayloadSchema = z.object({ peripherals: z.array(peripheralSchema).max(200) });

/** Why the agent locked itself (state_report.lockReason). */
export const AGENT_LOCK_REASONS = ['lease_expired', 'command', 'gamer_ended', 'startup'] as const;
export type AgentLockReason = (typeof AGENT_LOCK_REASONS)[number];

/** An ISO timestamp the agent read off the server clock; a bad one is dropped, not the report. */
const serverTimestamp = z.string().datetime({ offset: true }).optional().catch(undefined);

/**
 * state_report on (re)connect. `restarted`, `offlineSince`, `lockedAt` and
 * `lockReason` are optional (newer agents): `restarted` means the station
 * rebooted or the agent restarted since its last connection; `offlineSince` is
 * when it lost the backend and `lockedAt` when it locked itself (both on the
 * server clock). Missing fields leave reconnect handling as before.
 */
export const stateReportPayloadSchema = z.object({
  locked: z.boolean().optional(),
  sessionId: z.string().nullish(),
  runningGameId: z.string().nullish(),
  leaseExpiresAt: z.string().nullish(),
  peripherals: z.array(peripheralSchema).max(200).optional(),
  restarted: z.boolean().optional().catch(undefined),
  offlineSince: serverTimestamp,
  lockedAt: serverTimestamp,
  lockReason: z.enum(AGENT_LOCK_REASONS).optional().catch(undefined),
});
export type StateReportPayload = z.infer<typeof stateReportPayloadSchema>;

/**
 * login_request: the lock screen relays what the gamer typed; the agent
 * validates nothing. Unknown extra fields are ignored.
 */
export const loginRequestPayloadSchema = z.object({
  method: z.string().trim().min(1).max(32),
  credential: z.string().min(1).max(128),
});
export type LoginRequestPayload = z.infer<typeof loginRequestPayloadSchema>;

export const stationIdParamSchema = z.string().uuid();

export const renameStationSchema = z.object({ name: z.string().trim().min(1).max(64) });
export type RenameStationDto = z.infer<typeof renameStationSchema>;

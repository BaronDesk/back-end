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

export const stateReportPayloadSchema = z.object({
  locked: z.boolean().optional(),
  sessionId: z.string().nullish(),
  runningGameId: z.string().nullish(),
  leaseExpiresAt: z.string().nullish(),
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

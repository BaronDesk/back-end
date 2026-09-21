import { z } from "zod";
import { AGENT_MESSAGES } from "./realtime.types.js";

export const envelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().uuid(),
  ts: z.string().datetime(),
  seq: z.number().int().gte(0),
  payload: z.unknown(),
});

export const handshakePayloadSchema = z.object({
  machineId: z.string().uuid(),
  agentVersion: z.string().min(1),
  branchId: z.string().uuid(),
});

export const heartbeatPayloadSchema = z.object({
  status: z.enum(["idle", "in_use", "locked", "error"]),
  uptimeSeconds: z.number().int().gte(0),
});

export const agentMessageTypeSchema = z.enum(AGENT_MESSAGES);

export type EnvelopeShape = z.infer<typeof envelopeSchema>;
export type HandshakePayload = z.infer<typeof handshakePayloadSchema>;
export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
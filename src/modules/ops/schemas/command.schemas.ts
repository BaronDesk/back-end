import { z } from 'zod';

import { AGENT_COMMANDS } from '../../../infra/realtime/constants.js';

/** The commands this step can issue. LAUNCH_GAME / END_SESSION / POLICY_UPDATE come later. */
export const STATION_COMMAND_TYPES = [AGENT_COMMANDS.LOCK, AGENT_COMMANDS.UNLOCK, AGENT_COMMANDS.SHUTDOWN] as const;
export type StationCommandType = (typeof STATION_COMMAND_TYPES)[number];

/**
 * Dev-only fault injection for the physical test. `stale_ts` stamps the frame
 * with a ts far in the past so the agent's ReplayGuard nacks it STALE;
 * `duplicate_send` delivers the same command (same id) twice to prove the
 * agent acts once. Rejected outside development/test.
 */
export const COMMAND_SIMULATIONS = ['stale_ts', 'duplicate_send'] as const;
export type CommandSimulation = (typeof COMMAND_SIMULATIONS)[number];

export const issueCommandBodySchema = z.object({
  type: z.enum(STATION_COMMAND_TYPES),
  simulate: z.enum(COMMAND_SIMULATIONS).optional(),
});
export type IssueCommandBody = z.infer<typeof issueCommandBodySchema>;

export const listCommandsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListCommandsQuery = z.infer<typeof listCommandsQuerySchema>;

export const NACK_CODES = {
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  STALE: 'STALE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  EXEC_FAILED: 'EXEC_FAILED',
} as const;

export const commandAckPayloadSchema = z.object({
  commandId: z.string().uuid(),
});
export type CommandAckPayload = z.infer<typeof commandAckPayloadSchema>;

// `code` stays an open string: an unknown code from a newer agent is still
// recorded rather than dropped.
export const commandNackPayloadSchema = z.object({
  commandId: z.string().uuid(),
  code: z.string().min(1),
  reason: z.string().nullish(),
});
export type CommandNackPayload = z.infer<typeof commandNackPayloadSchema>;

/** What a BullMQ `commands` job carries. */
export interface CommandJobData {
  commandId: string;
  simulate?: CommandSimulation;
}

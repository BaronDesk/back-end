import { z } from 'zod';

import { AGENT_COMMANDS } from '../../../infra/realtime/constants.js';

/** The commands this step can issue. LAUNCH_GAME / END_SESSION / POLICY_UPDATE come later. */
export const STATION_COMMAND_TYPES = [AGENT_COMMANDS.LOCK, AGENT_COMMANDS.UNLOCK, AGENT_COMMANDS.SHUTDOWN] as const;
export type StationCommandType = (typeof STATION_COMMAND_TYPES)[number];

/**
 * Dev-only fault injection for the physical test. Rejected outside
 * development/test.
 * - `stale_ts`: backdates the frame's ts so the agent's ReplayGuard nacks STALE.
 * - `duplicate_send`: delivers the same command (same id) twice; the agent
 *   runs it once and re-acks the duplicate.
 * - `exec_failed`: puts a LAUNCH_GAME with no gameId on the wire under this
 *   commandId. LOCK/UNLOCK/SHUTDOWN handlers never fail on the agent, so this
 *   is the only way to get a real EXEC_FAILED ("Game ID is required.").
 */
export const COMMAND_SIMULATIONS = ['stale_ts', 'duplicate_send', 'exec_failed'] as const;
export type CommandSimulation = (typeof COMMAND_SIMULATIONS)[number];

/**
 * UNLOCK has two modes on the agent (UnlockCommandHandler):
 * - no payload / `{}`: direct (admin) unlock. The agent unlocks at once and
 *   grants the lease. This is the dashboard "unlock" button.
 * - `{ sessionId, pin }`: booking unlock. The agent starts the session but
 *   STAYS LOCKED until the user types the PIN on the station's LockUI.
 */
export const bookingUnlockPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  pin: z.string().min(1),
});
export type BookingUnlockPayload = z.infer<typeof bookingUnlockPayloadSchema>;

export const issueCommandBodySchema = z
  .object({
    type: z.enum(STATION_COMMAND_TYPES),
    // `{}` is the explicit admin form; anything else must be a full booking payload.
    payload: z.union([z.object({}).strict(), bookingUnlockPayloadSchema]).optional(),
    simulate: z.enum(COMMAND_SIMULATIONS).optional(),
  })
  .refine((body) => body.type === 'UNLOCK' || !body.payload || Object.keys(body.payload).length === 0, {
    message: 'payload is only accepted for UNLOCK',
    path: ['payload'],
  })
  .transform(({ payload, ...body }) => {
    // Normalized: `payload` is set only for a booking unlock; admin form -> undefined.
    const booking = bookingUnlockPayloadSchema.safeParse(payload);
    return { ...body, payload: booking.success ? booking.data : undefined };
  });
export type IssueCommandBody = z.infer<typeof issueCommandBodySchema>;

export const listCommandsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListCommandsQuery = z.infer<typeof listCommandsQuerySchema>;

/**
 * The codes the agent emits (NackCodes.cs / CommandResult.cs). Each carries a
 * human-readable `reason`.
 * - UNKNOWN_TYPE: type not in the agent's allow-list.
 * - INVALID_PAYLOAD: payload missing, malformed or failing field validation
 *   (e.g. "sessionId is required."). The backend built the command wrong.
 * - EXEC_FAILED: valid payload, but the action could not be carried out.
 * - STALE: failed the agent's seq/ts anti-replay check.
 */
export const NACK_CODES = {
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  EXEC_FAILED: 'EXEC_FAILED',
  STALE: 'STALE',
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
  /** Booking-unlock payload. Lives only in the job (never in Postgres or logs): it holds the PIN. */
  payload?: BookingUnlockPayload;
  simulate?: CommandSimulation;
}

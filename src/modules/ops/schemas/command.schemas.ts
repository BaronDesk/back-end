import { z } from 'zod';

import { AGENT_COMMANDS } from '../../../infra/realtime/constants.js';

/** The commands staff can issue. */
export const STATION_COMMAND_TYPES = [
  AGENT_COMMANDS.LOCK,
  AGENT_COMMANDS.UNLOCK,
  AGENT_COMMANDS.SHUTDOWN,
  AGENT_COMMANDS.LAUNCH_GAME,
  AGENT_COMMANDS.END_SESSION,
  AGENT_COMMANDS.CATALOG_UPDATE,
  AGENT_COMMANDS.POLICY_UPDATE,
] as const;
export type StationCommandType = (typeof STATION_COMMAND_TYPES)[number];

/**
 * Dev-only fault injection for the physical test. Rejected outside
 * development/test.
 * - `stale_ts`: backdates the frame's ts so the agent's ReplayGuard nacks STALE.
 * - `duplicate_send`: delivers the same command (same id) twice; the agent
 *   runs it once and re-acks the duplicate.
 * - `invalid_payload`: puts a LAUNCH_GAME with an empty gameId on the wire
 *   under this commandId, whatever the issued type. The agent nacks
 *   INVALID_PAYLOAD ("gameId is required (1-128 characters).").
 * - `exec_failed`: puts a LAUNCH_GAME for a gameId that is in no catalog on
 *   the wire. The agent nacks EXEC_FAILED: "must be unlocked with an active
 *   session" while locked, else "not in catalog".
 * Both skip the backend's LAUNCH_GAME pre-checks: they exist to see the
 * agent's own rejection.
 */
export const COMMAND_SIMULATIONS = ['stale_ts', 'duplicate_send', 'invalid_payload', 'exec_failed'] as const;
export type CommandSimulation = (typeof COMMAND_SIMULATIONS)[number];

/**
 * Session UNLOCK, sent by the backend only: after an accepted login_result,
 * or to resume a session on reconnect. The agent binds `sessionId`, takes the
 * lease and unlocks. It never carries a PIN: the PIN is checked server-side
 * against the login_request. Staff cannot build one over REST.
 */
export type SessionUnlockPayload = {
  sessionId: string;
  leaseSeconds: number;
  serverTime: string;
};

/**
 * LAUNCH_GAME: `gameId` is the catalog's wire gameId, exactly as
 * GET /stations/me/games served it. The agent launches that entry from its
 * synced catalog; no path or target ever goes on the wire.
 * END_SESSION: optional `reason` (the agent defaults it to "normal").
 * CATALOG_UPDATE: no payload; the agent re-pulls GET /stations/me/games.
 */
export const issueCommandBodySchema = z
  .object({
    type: z.enum(STATION_COMMAND_TYPES),
    // Only the empty admin form: a session UNLOCK is backend-issued after login.
    payload: z.object({}).strict().optional(),
    gameId: z.string().trim().min(1).max(128).optional(),
    reason: z.string().trim().min(1).max(200).optional(),
    simulate: z.enum(COMMAND_SIMULATIONS).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.type === 'LAUNCH_GAME' && !body.gameId) {
      ctx.addIssue({ code: 'custom', message: 'gameId is required for LAUNCH_GAME', path: ['gameId'] });
    }
    if (body.type !== 'LAUNCH_GAME' && body.gameId) {
      ctx.addIssue({ code: 'custom', message: 'gameId is only accepted for LAUNCH_GAME', path: ['gameId'] });
    }
    if (body.type !== 'END_SESSION' && body.reason) {
      ctx.addIssue({ code: 'custom', message: 'reason is only accepted for END_SESSION', path: ['reason'] });
    }
  })
  // The only accepted payload is empty: nothing of it goes on the wire.
  .transform(({ payload: _payload, ...body }) => body);
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

/** LAUNCH_GAME wire payload: the catalog entry's wire gameId. */
export type LaunchGamePayload = { gameId: string };

/** END_SESSION wire payload. `{}` makes the agent default the reason to "normal". */
export type EndSessionPayload = { reason?: string };

export type CommandPayload = SessionUnlockPayload | LaunchGamePayload | EndSessionPayload | Record<string, never>;

/** What a BullMQ `commands` job carries. */
export interface CommandJobData {
  commandId: string;
  /** Wire payload. Lives only in the job, never in Postgres or logs. */
  payload?: CommandPayload;
  simulate?: CommandSimulation;
}

export const policyUpdatePayloadSchema = z.object({
  alertThresholds: z.object({
    cpuTempC: z.number().positive().optional(),
    gpuTempC: z.number().positive().optional()
  }).optional(),
  telemetryCadenceSeconds: z.number().int().positive().optional(),
  usbDebounceMs: z.number().int().positive().optional(),
}).strict();
export type PolicyUpdatePayload = z.infer<typeof policyUpdatePayloadSchema>;

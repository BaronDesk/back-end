/**
 * The replay window: an agent frame whose `ts` is further than this from the
 * server's clock, either way, is dropped. A frame exactly at the edge is kept.
 */
export const REPLAY_WINDOW_MS = 30_000;

export type SeqCheckResult =
  | { ok: true }
  | { ok: false; reason: 'seq_replay' }
  /** skewMs: frame ts minus server time (negative = the frame is behind). */
  | { ok: false; reason: 'ts_out_of_window'; skewMs: number };

/**
 * Per-connection anti-replay state. One instance lives per socket for its
 * whole lifetime — sequence numbers must strictly increase, and timestamps
 * must fall within REPLAY_WINDOW_MS of "now".
 */
export class SeqGuard {
  private lastSeq = -1;

  check(envelope: { seq: number; ts: number }): SeqCheckResult {
    if (envelope.seq <= this.lastSeq) {
      return { ok: false, reason: 'seq_replay' };
    }
    const skewMs = envelope.ts - Date.now();
    if (Math.abs(skewMs) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: 'ts_out_of_window', skewMs };
    }
    this.lastSeq = envelope.seq;
    return { ok: true };
  }
}

/** The log detail of a dropped frame, e.g. "ts 45.0s behind server time, window ±30s". */
export function describeDrop(result: Exclude<SeqCheckResult, { ok: true }>): string | null {
  if (result.reason !== 'ts_out_of_window') return null;
  const seconds = (Math.abs(result.skewMs) / 1000).toFixed(1);
  return `ts ${seconds}s ${result.skewMs < 0 ? 'behind' : 'ahead of'} server time, window ±${REPLAY_WINDOW_MS / 1000}s`;
}

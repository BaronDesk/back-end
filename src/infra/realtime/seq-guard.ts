const REPLAY_WINDOW_MS = 30_000;

export type SeqCheckResult = { ok: true } | { ok: false; reason: 'seq_replay' | 'ts_out_of_window' };

/**
 * Per-connection anti-replay state. One instance lives per socket for its
 * whole lifetime — sequence numbers must strictly increase, and timestamps
 * must fall within a rolling window of "now".
 */
export class SeqGuard {
  private lastSeq = -1;

  check(envelope: { seq: number; ts: number }): SeqCheckResult {
    if (envelope.seq <= this.lastSeq) {
      return { ok: false, reason: 'seq_replay' };
    }
    if (Math.abs(Date.now() - envelope.ts) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: 'ts_out_of_window' };
    }
    this.lastSeq = envelope.seq;
    return { ok: true };
  }
}

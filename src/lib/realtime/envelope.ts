import { randomUUID } from "node:crypto";
import { BadRequestError } from "../app-error";
import { envelopeSchema } from "../../shared/schemas/realtime.schemas";
import { Envelope } from "../../shared/types/realtime";

export function makeFrame<T>(type: string, payload: T, seq: number): Envelope<T> {
  return {
    type,
    id: randomUUID(),
    ts: new Date().toISOString(),
    seq,
    payload,
  };
}

export function parseFrame(raw: string | Buffer): Envelope {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    throw new BadRequestError("Malformed frame: not valid JSON", "INVALID_FRAME");
  }

  const result = envelopeSchema.safeParse(json);
  if (!result.success) {
    throw new BadRequestError("Malformed frame: does not match envelope shape", "INVALID_FRAME");
  }

  return result.data as Envelope;
}

const REPLAY_WINDOW_MS = 30_000;

/**
 * Per-connection anti-replay guard: rejects a frame whose seq does not
 * strictly increase, or whose ts falls outside a 30s window of "now" (clock
 * skew / replayed-from-capture protection). One instance per connection.
 */
export class SeqGuard {
  private lastSeq = -1;

  check(envelope: Envelope): { ok: true } | { ok: false; reason: string } {
    if (envelope.seq <= this.lastSeq) {
      return { ok: false, reason: "SEQ_REPLAYED" };
    }

    const frameTime = Date.parse(envelope.ts);
    if (Number.isNaN(frameTime) || Math.abs(Date.now() - frameTime) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "TS_OUT_OF_WINDOW" };
    }

    this.lastSeq = envelope.seq;
    return { ok: true };
  }
}

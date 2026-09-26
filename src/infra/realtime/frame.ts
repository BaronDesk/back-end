import { randomUUID } from 'node:crypto';

import { envelopeSchema, type Envelope, type OutboundEnvelope } from './envelope.js';

export function makeFrame(envelope: Envelope | OutboundEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseFrame(raw: string | Buffer): Envelope {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return envelopeSchema.parse(JSON.parse(text));
}

/**
 * Per-connection stamper for server-to-agent frames. The agent's replay guard
 * rejects any seq <= the last one it accepted (starting from 0), so the first
 * frame goes out as seq 1 and every frame gets a fresh ts. The id is fresh
 * too, unless the caller passes one: commands reuse their commandId on every
 * resend because the agent keys idempotency off it.
 */
export class OutboundSequencer {
  private seq = 0;

  next<T>(type: string, payload?: T, id: string = randomUUID()): OutboundEnvelope<T> {
    this.seq += 1;
    return { type, id, ts: new Date().toISOString(), seq: this.seq, payload };
  }
}

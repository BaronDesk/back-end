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
 * frame goes out as seq 1 and every frame gets a fresh id and ts.
 */
export class OutboundSequencer {
  private seq = 0;

  next<T>(type: string, payload?: T): OutboundEnvelope<T> {
    this.seq += 1;
    return { type, id: randomUUID(), ts: new Date().toISOString(), seq: this.seq, payload };
  }
}

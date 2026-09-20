import { envelopeSchema, type Envelope } from './envelope.js';

export function makeFrame(envelope: Envelope): string {
  return JSON.stringify(envelope);
}

export function parseFrame(raw: string | Buffer): Envelope {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  return envelopeSchema.parse(JSON.parse(text));
}

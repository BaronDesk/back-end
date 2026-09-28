import { z } from 'zod';

// Agents (.NET DateTimeOffset) send `ts` as ISO-8601; older/internal callers
// send epoch ms. Both normalize to epoch ms so SeqGuard compares numbers.
const tsSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) {
        ctx.addIssue({ code: 'custom', message: 'ts is not a valid ISO-8601 timestamp' });
        return z.NEVER;
      }
      return ms;
    }),
]);

export const envelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  ts: tsSchema,
  seq: z.number().int().nonnegative(),
  payload: z.unknown().optional(),
});

/** Inbound envelope after parsing: `ts` is always epoch ms. */
export type Envelope<T = unknown> = {
  type: string;
  id: string;
  ts: number;
  seq: number;
  payload?: T;
};

/** Server-to-agent envelope as it goes on the wire: `ts` is ISO-8601. */
export type OutboundEnvelope<T = unknown> = {
  type: string;
  id: string;
  ts: string;
  seq: number;
  payload?: T;
};

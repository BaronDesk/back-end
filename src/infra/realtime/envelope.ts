import { z } from 'zod';

export const envelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  ts: z.number().int().positive(),
  seq: z.number().int().nonnegative(),
  payload: z.unknown().optional(),
});

export type Envelope<T = unknown> = {
  type: string;
  id: string;
  ts: number;
  seq: number;
  payload?: T;
};

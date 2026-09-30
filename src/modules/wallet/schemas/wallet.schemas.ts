import { z } from 'zod';

const amountSchema = z.number().int().positive().max(2_147_483_647);

export const gamerProfileIdParamSchema = z.string().uuid();

const movementSchema = z.object({
  amount: amountSchema,
  type: z.enum(['PAYMENT', 'REFUND', 'ADJUSTMENT', 'CREDIT', 'DEBIT']).optional(),
  sessionId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

// Money in is a top-up (CREDIT), a REFUND or an ADJUSTMENT; money out a DEBIT, PAYMENT or ADJUSTMENT.
export const creditSchema = movementSchema.extend({ type: z.enum(['CREDIT', 'REFUND', 'ADJUSTMENT']).optional() });
export type CreditDto = z.infer<typeof creditSchema>;

export const debitSchema = movementSchema.extend({ type: z.enum(['DEBIT', 'PAYMENT', 'ADJUSTMENT']).optional() });
export type DebitDto = z.infer<typeof debitSchema>;

export const listEntriesQuerySchema = z.object({
  take: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});
export type ListEntriesQuery = z.infer<typeof listEntriesQuerySchema>;

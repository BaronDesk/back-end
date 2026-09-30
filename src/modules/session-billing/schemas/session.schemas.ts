import { z } from 'zod';

export const startSessionSchema = z.object({ reservationId: z.string().uuid() });
export type StartSessionDto = z.infer<typeof startSessionSchema>;

export const idParamSchema = z.string().uuid();

export const listSessionsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
  from: z.string().datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const endSessionBodySchema = z.object({ reason: z.string().trim().min(1).max(200).optional() });
export type EndSessionBodyDto = z.infer<typeof endSessionBodySchema>;

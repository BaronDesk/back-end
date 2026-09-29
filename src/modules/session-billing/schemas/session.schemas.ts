import { z } from 'zod';

export const startSessionSchema = z.object({ reservationId: z.string().uuid() });
export type StartSessionDto = z.infer<typeof startSessionSchema>;

export const idParamSchema = z.string().uuid();

export const endSessionBodySchema = z.object({ reason: z.string().trim().min(1).max(200).optional() });
export type EndSessionBodyDto = z.infer<typeof endSessionBodySchema>;

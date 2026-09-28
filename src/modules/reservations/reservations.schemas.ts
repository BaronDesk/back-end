import { z } from 'zod';

const timestamp = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const createReservationSchema = z
  .object({
    machineId: z.string().uuid(),
    startTime: timestamp,
    endTime: timestamp,
  })
  .refine((value) => value.endTime > value.startTime, {
    path: ['endTime'],
    message: 'endTime must be after startTime',
  });
export type CreateReservationDto = z.infer<typeof createReservationSchema>;

export const walkInSchema = z.object({
  machineId: z.string().uuid(),
  durationMinutes: z.number().int().min(1).max(24 * 60),
});
export type WalkInDto = z.infer<typeof walkInSchema>;

export const reservationIdSchema = z.string().uuid();

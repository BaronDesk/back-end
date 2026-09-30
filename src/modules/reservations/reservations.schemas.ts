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

export const staffListQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  status: z.enum(['PENDING', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type StaffListQuery = z.infer<typeof staffListQuerySchema>;

/** Extra time near the end of a running booking. */
export const extendSchema = z.object({ minutes: z.union([z.literal(30), z.literal(60), z.literal(90)]) });
export type ExtendDto = z.infer<typeof extendSchema>;

import { z } from 'zod';

export const checkAvailabilitySchema = z.object({
  branchId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});
export type CheckAvailabilityDto = z.infer<typeof checkAvailabilitySchema>;

export const createReservationSchema = z.object({
  machineId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});
export type CreateReservationDto = z.infer<typeof createReservationSchema>;
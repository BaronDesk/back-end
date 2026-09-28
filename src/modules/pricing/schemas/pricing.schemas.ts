import { z } from 'zod';

export const branchIdParamSchema = z.string().uuid();

const rateSchema = z.number().int().positive().max(100_000_000);

export const upsertPricingSchema = z.object({
  paygRate: rateSchema,
  bookingRate: rateSchema,
});
export type UpsertPricingDto = z.infer<typeof upsertPricingSchema>;

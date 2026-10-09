import { z } from 'zod';

import { uploadedImageUrlSchema } from '../../uploads/schemas/image-url.schema.js';

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const benefitWindowSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startTime: timeSchema,
  endTime: timeSchema,
  discountPercent: z.number().min(0).max(100),
});
export type BenefitWindow = z.infer<typeof benefitWindowSchema>;

/** A pass's benefits, as plans store them and purchases snapshot them. */
export const benefitsSchema = z.object({ windows: z.array(benefitWindowSchema).max(50) });

export const idParamSchema = z.string().uuid();
export const createSubscriptionPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Whole coins. */
  price: z.number().int().min(0).max(2_000_000_000),
  durationDays: z.number().int().positive().max(3650),
  benefits: benefitsSchema.strict(),
  /** From POST /uploads/images; null removes it. */
  badgeUrl: uploadedImageUrlSchema.optional(),
});
export type CreateSubscriptionPlanDto = z.infer<
  typeof createSubscriptionPlanSchema
>;

export const updateSubscriptionPlanSchema = createSubscriptionPlanSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one field is required',
  );
export type UpdateSubscriptionPlanDto = z.infer<
  typeof updateSubscriptionPlanSchema
>;

export const purchaseSubscriptionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type PurchaseSubscriptionDto = z.infer<
  typeof purchaseSubscriptionSchema
>;

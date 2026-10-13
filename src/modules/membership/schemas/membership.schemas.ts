import { z } from 'zod';

import { uploadedImageUrlSchema } from '../../uploads/schemas/image-url.schema.js';

/** Whole coins. */
const coinsSchema = z.number().int().min(0).max(2_000_000_000);

export const idParamSchema = z.string().uuid();
export const planIdParamSchema = z.string().uuid();

export const createMembershipPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  price: coinsSchema,
  durationDays: z.number().int().positive().max(3650),
  discountPercent: z.number().min(0).max(100),
  bookingAdvanceDays: z.number().int().min(0).max(365).default(7),
  /** From POST /uploads/images; null removes it. */
  badgeUrl: uploadedImageUrlSchema.optional(),
});
export type CreateMembershipPlanDto = z.infer<
  typeof createMembershipPlanSchema
>;

export const updateMembershipPlanSchema = createMembershipPlanSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one field is required',
  );
export type UpdateMembershipPlanDto = z.infer<
  typeof updateMembershipPlanSchema
>;

export const purchaseMembershipSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type PurchaseMembershipDto = z.infer<typeof purchaseMembershipSchema>;

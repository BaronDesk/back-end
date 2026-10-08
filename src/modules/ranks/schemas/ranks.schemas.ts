import { z } from 'zod';

import { uploadedImageUrlSchema } from '../../uploads/schemas/image-url.schema.js';

export const idParamSchema = z.string().uuid();

export const createRankSchema = z.object({
  name: z.string().trim().min(1).max(50),
  /** The XP from which a gamer holds this rank. */
  minXp: z.number().int().min(0).max(100_000_000),
  badgeUrl: uploadedImageUrlSchema.optional(),
});
export type CreateRankDto = z.infer<typeof createRankSchema>;

export const updateRankSchema = createRankSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type UpdateRankDto = z.infer<typeof updateRankSchema>;

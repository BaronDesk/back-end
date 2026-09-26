import { z } from 'zod';

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits and single dashes');

export const createGameSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
  // Sent to the agent as LAUNCH_GAME's opaque `gameId`.
  launchRef: z.string().trim().min(1).max(512),
  iconUrl: z.string().url().max(2048).nullable().optional(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateGameDto = z.infer<typeof createGameSchema>;

export const updateGameSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slugSchema,
    launchRef: z.string().trim().min(1).max(512),
    iconUrl: z.string().url().max(2048).nullable(),
    enabled: z.boolean(),
    sortOrder: z.number().int(),
  })
  .partial()
  .refine((dto) => Object.keys(dto).length > 0, { message: 'nothing to update' });
export type UpdateGameDto = z.infer<typeof updateGameSchema>;

export const gameIdParamSchema = z.string().uuid();

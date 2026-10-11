import { z } from 'zod';

export const idSchema = z.string().uuid();
export const createTournamentSchema = z
  .object({
    branchId: idSchema,
    gameId: idSchema,
    entryFeePerPlayer: z.number().int().min(0).max(2_147_483_647),
    teamSize: z.number().int().min(1).max(16).default(1),
    maxEntrants: z.number().int().min(2).max(256),
    registrationClosesAt: z.coerce.date(),
    checkInOpensAt: z.coerce.date(),
    checkInClosesAt: z.coerce.date(),
    prizes: z
      .array(
        z.object({
          place: z.number().int().positive(),
          reward: z.string().trim().min(1).max(200),
        }),
      )
      .max(32)
      .default([]),
  })
  .refine(
    (x) =>
      x.registrationClosesAt < x.checkInOpensAt &&
      x.checkInOpensAt < x.checkInClosesAt,
    'deadlines must be ordered',
  );
export const entrantSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export const inviteSchema = z.object({
  username: z.string().trim().min(1).max(64),
});
export const resultSchema = z.object({
  version: z.number().int().positive(),
  winnerEntrantId: idSchema,
  scores: z.array(z.number().int().min(0)).min(2).max(8),
});

export type CreateTournamentDto = z.infer<typeof createTournamentSchema>;

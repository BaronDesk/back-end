import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const logoutSchema = z.object({
  refreshToken: z.string().min(10),
});
export type LogoutDto = z.infer<typeof logoutSchema>;

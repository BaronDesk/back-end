import { z } from 'zod';

const password = z.string().min(8).max(128);

export const createGamerSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password,
  /** The branch the gamer plays at (the booking page lists its stations). */
  branchId: z.string().uuid(),
});
export type CreateGamerDto = z.infer<typeof createGamerSchema>;

export const createEmployeeSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password,
  role: z.enum(['EMPLOYEE', 'MANAGER']),
  branchId: z.string().uuid(),
});
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

export const updateRoleSchema = z.object({
  role: z.enum(['GAMER', 'EMPLOYEE', 'MANAGER', 'ADMIN']),
  branchId: z.string().uuid().nullable().optional(),
});
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

export const idParamSchema = z.string().uuid();

export const updateStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });
export type UpdateStatusDto = z.infer<typeof updateStatusSchema>;

export const homeBranchSchema = z.object({ branchId: z.string().uuid() });
export type HomeBranchDto = z.infer<typeof homeBranchSchema>;

export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(64).optional(),
  role: z.enum(['GAMER', 'EMPLOYEE', 'MANAGER', 'ADMIN']).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const searchGamersQuerySchema = z.object({ q: z.string().trim().min(1).max(64) });
export type SearchGamersQuery = z.infer<typeof searchGamersQuerySchema>;

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.object({ newPassword: password });
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;

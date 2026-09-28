import { z } from 'zod';

export const createGamerSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});
export type CreateGamerDto = z.infer<typeof createGamerSchema>;

export const createEmployeeSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
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

// branchId only has an effect for an hq caller — a non-hq caller is always
// scoped to their own branch (see UsersService.list).
export const listUsersQuerySchema = z.object({
  role: z.enum(['GAMER', 'EMPLOYEE', 'MANAGER', 'ADMIN']).optional(),
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE', 'DELETED']).optional(),
  branchId: z.string().uuid().optional(),
});
export type ListUsersQueryDto = z.infer<typeof listUsersQuerySchema>;

export const updateAccountStatusSchema = z.object({
  accountStatus: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE', 'DELETED']),
});
export type UpdateAccountStatusDto = z.infer<typeof updateAccountStatusSchema>;

export const updateEmploymentStatusSchema = z.object({
  employmentStatus: z.enum(['ACTIVE', 'INACTIVE', 'ON_LEAVE', 'TERMINATED']),
});
export type UpdateEmploymentStatusDto = z.infer<typeof updateEmploymentStatusSchema>;

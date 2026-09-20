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

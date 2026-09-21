import { z } from "zod";
import { UserRole } from "@prisma/client";

const uuid = z.string().uuid();

// One Zod schema per request part; controllers attach them with
// `new ZodValidationPipe(schema)` on @Body() / @Param().

// --- Auth ---

export const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = z.object({
  // jti of the refresh token to revoke. Optional: if omitted, revokes the
  // refresh token that matches the caller's current session where possible.
  jti: z.string().uuid().optional(),
  refreshToken: z.string().min(1).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;

// --- Users ---

export const createGamerSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
  email: z.string().email().optional(),
});

export const createEmployeeSchema = z.object({
  branchId: uuid,
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
  role: z.enum([UserRole.EMPLOYEE, UserRole.MANAGER]),
  hireDate: z.coerce.date().optional(),
});

export const updateUserRoleSchema = z.object({
  role: z.nativeEnum(UserRole),
});

export const userIdParamSchema = z.object({ id: uuid });

export type CreateGamerInput = z.infer<typeof createGamerSchema>;
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;
export type UserIdParam = z.infer<typeof userIdParamSchema>;

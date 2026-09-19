import { z } from "zod";
import { UserRole } from "@prisma/client";

const uuid = z.string().uuid();

// --- Auth ---

export const loginSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(8).max(128),
  }),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1),
  }),
});

export const logoutSchema = z.object({
  body: z.object({
    // jti of the refresh token to revoke. Optional: if omitted, revokes the
    // refresh token that matches the caller's current session where possible.
    jti: z.string().uuid().optional(),
    refreshToken: z.string().min(1).optional(),
  }),
});

export type LoginInput = z.infer<typeof loginSchema>["body"];
export type RefreshInput = z.infer<typeof refreshSchema>["body"];
export type LogoutInput = z.infer<typeof logoutSchema>["body"];

// --- Users ---

export const createGamerSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(8).max(128),
    email: z.string().email().optional(),
  }),
});

export const createEmployeeSchema = z.object({
  body: z.object({
    branchId: uuid,
    username: z.string().min(3).max(64),
    password: z.string().min(8).max(128),
    role: z.enum([UserRole.EMPLOYEE, UserRole.MANAGER]),
    hireDate: z.coerce.date().optional(),
  }),
});

export const updateUserRoleSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({
    role: z.nativeEnum(UserRole),
  }),
});

export const getUserSchema = z.object({
  params: z.object({ id: uuid }),
});

export type CreateGamerInput = z.infer<typeof createGamerSchema>["body"];
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>["body"];
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>["body"];

import { Prisma, UserRole } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Sole entry point onto the identity tables (users, employee/gamer profiles,
 * refresh_tokens). Other modules must not import `lib/prisma` to touch these
 * tables directly — they call into `auth.service`/`users.service`, which call
 * this repository.
 */

export function findUserByUsername(username: string) {
  return prisma.user.findUnique({ where: { username } });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findUserWithProfiles(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      role: true,
      accountStatus: true,
      createdAt: true,
      employeeProfile: { select: { managedBranchId: true, employmentStatus: true } },
      gamerProfile: { select: { xp: true, level: true } },
    },
  });
}

export function findEmployeeProfileByUserId(userId: string) {
  return prisma.employeeProfile.findUnique({
    where: { userId },
    select: { managedBranchId: true },
  });
}

export function createGamerUser(data: { username: string; passwordHash: string }) {
  return prisma.user.create({
    data: {
      username: data.username,
      passwordHash: data.passwordHash,
      role: UserRole.GAMER,
      gamerProfile: { create: {} },
    },
    select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
  });
}

export function createEmployeeUser(data: {
  username: string;
  passwordHash: string;
  role: UserRole;
  managedBranchId: string;
  hireDate: Date;
}) {
  return prisma.user.create({
    data: {
      username: data.username,
      passwordHash: data.passwordHash,
      role: data.role,
      employeeProfile: {
        create: {
          managedBranchId: data.managedBranchId,
          hireDate: data.hireDate,
        },
      },
    },
    select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
  });
}

export function updateUserRole(id: string, role: UserRole) {
  return prisma.user.update({
    where: { id },
    data: { role },
    select: { id: true, username: true, role: true, accountStatus: true },
  });
}

export function createRefreshToken(data: { jti: string; userId: string; expiresAt: Date }) {
  return prisma.refreshToken.create({ data });
}

export function findRefreshTokenByJti(jti: string) {
  return prisma.refreshToken.findUnique({ where: { jti } });
}

export function revokeRefreshToken(jti: string) {
  return prisma.refreshToken.update({ where: { jti }, data: { revoked: true } });
}

export function rotateRefreshToken(
  oldJti: string,
  next: { jti: string; userId: string; expiresAt: Date }
) {
  return prisma.$transaction([
    prisma.refreshToken.update({
      where: { jti: oldJti },
      data: { revoked: true, replacedByJti: next.jti },
    }),
    prisma.refreshToken.create({
      data: { jti: next.jti, userId: next.userId, expiresAt: next.expiresAt },
    }),
  ]);
}

export function createAuditLog(data: Prisma.AuditLogUncheckedCreateInput) {
  return prisma.auditLog.create({ data });
}

import { Inject, Injectable } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Sole entry point onto the identity tables (users, employee/gamer profiles,
 * refresh_tokens, audit_logs). Other modules must not inject PrismaService to
 * touch these tables directly — they call into `AuthService`/`UsersService`
 * (exported by IdentityModule), which call this repository.
 */
@Injectable()
export class IdentityRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  findUserByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username } });
  }

  findUserById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findUserWithProfiles(id: string) {
    return this.prisma.user.findUnique({
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

  findEmployeeProfileByUserId(userId: string) {
    return this.prisma.employeeProfile.findUnique({
      where: { userId },
      select: { managedBranchId: true },
    });
  }

  createGamerUser(data: { username: string; passwordHash: string }) {
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        role: UserRole.GAMER,
        gamerProfile: { create: {} },
      },
      select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
    });
  }

  createEmployeeUser(data: {
    username: string;
    passwordHash: string;
    role: UserRole;
    managedBranchId: string;
    hireDate: Date;
  }) {
    return this.prisma.user.create({
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

  updateUserRole(id: string, role: UserRole) {
    return this.prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, username: true, role: true, accountStatus: true },
    });
  }

  createRefreshToken(data: { jti: string; userId: string; expiresAt: Date }) {
    return this.prisma.refreshToken.create({ data });
  }

  findRefreshTokenByJti(jti: string) {
    return this.prisma.refreshToken.findUnique({ where: { jti } });
  }

  revokeRefreshToken(jti: string) {
    return this.prisma.refreshToken.update({ where: { jti }, data: { revoked: true } });
  }

  rotateRefreshToken(oldJti: string, next: { jti: string; userId: string; expiresAt: Date }) {
    return this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { jti: oldJti },
        data: { revoked: true, replacedByJti: next.jti },
      }),
      this.prisma.refreshToken.create({
        data: { jti: next.jti, userId: next.userId, expiresAt: next.expiresAt },
      }),
    ]);
  }

  createAuditLog(data: Prisma.AuditLogUncheckedCreateInput) {
    return this.prisma.auditLog.create({ data });
  }
}

import { Injectable } from '@nestjs/common';
import { AuditAction, UserRole } from '../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  findUserByUsername(username: string) { return this.prisma.user.findUnique({ where: { username } }); }
  findUserById(id: string) { return this.prisma.user.findUnique({ where: { id } }); }

  findUserWithProfiles(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, username: true, role: true, accountStatus: true, createdAt: true,
        employeeProfile: { select: { managedBranchId: true, employmentStatus: true } },
        gamerProfile: { select: { xp: true, level: true } },
      },
    });
  }

  findEmployeeProfileByUserId(userId: string) {
    return this.prisma.employeeProfile.findUnique({ where: { userId }, select: { managedBranchId: true } });
  }

  createGamerUser(data: { username: string; passwordHash: string }) {
    return this.prisma.user.create({
      data: { username: data.username, passwordHash: data.passwordHash, role: UserRole.GAMER, gamerProfile: { create: {} } },
      select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
    });
  }

  createEmployeeUser(data: { username: string; passwordHash: string; role: UserRole; managedBranchId: string; hireDate: Date }) {
    return this.prisma.user.create({
      data: {
        username: data.username, passwordHash: data.passwordHash, role: data.role,
        employeeProfile: { create: { managedBranchId: data.managedBranchId, hireDate: data.hireDate } },
      },
      select: { id: true, username: true, role: true, accountStatus: true, createdAt: true },
    });
  }

  updateUserRole(id: string, role: UserRole) {
    return this.prisma.user.update({ where: { id }, data: { role }, select: { id: true, username: true, role: true } });
  }

  createRefreshToken(data: { jti: string; userId: string; expiresAt: Date }) { return this.prisma.refreshToken.create({ data }); }
  findRefreshTokenByJti(jti: string) { return this.prisma.refreshToken.findUnique({ where: { jti } }); }

  async rotateRefreshToken(oldJti: string, next: { jti: string; userId: string; expiresAt: Date }) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({ where: { jti: oldJti }, data: { revoked: true, replacedByJti: next.jti } }),
                                   this.prisma.refreshToken.create({ data: next }),
    ]);
  }

  revokeRefreshToken(jti: string) { return this.prisma.refreshToken.update({ where: { jti }, data: { revoked: true } }); }
  createAuditLog(data: { userId: string; action: AuditAction; target: string }) { return this.prisma.auditLog.create({ data }); }
}

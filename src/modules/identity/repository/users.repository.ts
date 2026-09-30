import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { AccountStatus, Prisma, UserRole } from '../../../generated/prisma/index.js';

/** Enough of the profiles for the public user shape: staff branch, gamer profile and home branch. */
const withProfiles = {
  employeeProfile: true,
  gamerProfile: { select: { id: true, homeBranchId: true } },
} as const;

/** Page size cap for user lists. */
const MAX_LIST = 100;

@Injectable()
export class UsersRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
      include: withProfiles,
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: withProfiles,
    });
  }

  createGamer(data: { username: string; passwordHash: string; homeBranchId: string }) {
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        role: 'GAMER',
        gamerProfile: { create: { homeBranchId: data.homeBranchId } },
      },
      include: withProfiles,
    });
  }

  createEmployee(data: {
    username: string;
    passwordHash: string;
    role: 'EMPLOYEE' | 'MANAGER';
    branchId: string;
  }) {
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        role: data.role,
        employeeProfile: {
          create: { managedBranchId: data.branchId, hireDate: new Date() },
        },
      },
      include: withProfiles,
    });
  }

  setStatus(id: string, accountStatus: AccountStatus) {
    return this.prisma.user.update({ where: { id }, data: { accountStatus }, include: withProfiles });
  }

  setPasswordHash(id: string, passwordHash: string) {
    return this.prisma.user.update({ where: { id }, data: { passwordHash }, include: withProfiles });
  }

  setHomeBranch(userId: string, homeBranchId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { gamerProfile: { update: { homeBranchId } } },
      include: withProfiles,
    });
  }

  branchExists(id: string): Promise<boolean> {
    return this.prisma.branch.findUnique({ where: { id }, select: { id: true } }).then((b) => b !== null);
  }

  /**
   * Users matching `q` (username contains, case-insensitive), newest first.
   * `visibleBranchId`: below HQ, staff of other branches are left out
   * (gamers are everyone's customers and always listed).
   */
  list(filter: { q?: string; role?: UserRole; branchId?: string; visibleBranchId: string | null; limit: number }) {
    const where: Prisma.UserWhereInput = {
      ...(filter.q ? { username: { contains: filter.q, mode: 'insensitive' } } : {}),
      ...(filter.role ? { role: filter.role } : {}),
      ...(filter.branchId
        ? { OR: [{ employeeProfile: { managedBranchId: filter.branchId } }, { gamerProfile: { homeBranchId: filter.branchId } }] }
        : {}),
      ...(filter.visibleBranchId
        ? { OR: [{ role: 'GAMER' }, { employeeProfile: { managedBranchId: filter.visibleBranchId } }] }
        : {}),
    };
    // Both branch filters can apply: combine them with AND instead of overwriting OR.
    if (filter.branchId && filter.visibleBranchId) {
      delete where.OR;
      where.AND = [
        { OR: [{ employeeProfile: { managedBranchId: filter.branchId } }, { gamerProfile: { homeBranchId: filter.branchId } }] },
        { OR: [{ role: 'GAMER' }, { employeeProfile: { managedBranchId: filter.visibleBranchId } }] },
      ];
    }
    return this.prisma.user.findMany({
      where,
      include: withProfiles,
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit, MAX_LIST),
    });
  }

  updateRole(id: string, role: UserRole, branchId?: string | null) {
    return this.prisma.user.update({
      where: { id },
      data: {
        role,
        ...(branchId !== undefined
          ? {
              employeeProfile: {
                upsert: {
                  create: { managedBranchId: branchId, hireDate: new Date() },
                  update: { managedBranchId: branchId },
                },
              },
            }
          : {}),
      },
      include: withProfiles,
    });
  }
}

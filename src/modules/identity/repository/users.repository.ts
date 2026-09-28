import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { AccountStatus, EmploymentStatus, UserRole } from '../../../generated/prisma/index.js';

const withEmployeeProfile = { employeeProfile: true } as const;

@Injectable()
export class UsersRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByUsername(username: string) {
    return this.prisma.user.findUnique({
      where: { username },
      include: withEmployeeProfile,
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: withEmployeeProfile,
    });
  }

  createGamer(data: { username: string; passwordHash: string }) {
    return this.prisma.user.create({
      data: {
        username: data.username,
        passwordHash: data.passwordHash,
        role: 'GAMER',
        gamerProfile: { create: {} },
      },
      include: withEmployeeProfile,
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
      include: withEmployeeProfile,
    });
  }

  list(filter: { role?: UserRole; accountStatus?: AccountStatus; branchId?: string }) {
    const { branchId, ...rest } = filter;
    return this.prisma.user.findMany({
      where: {
        ...rest,
        ...(branchId ? { employeeProfile: { managedBranchId: branchId } } : {}),
      },
      include: withEmployeeProfile,
      orderBy: { createdAt: 'desc' },
    });
  }

  updateAccountStatus(id: string, accountStatus: AccountStatus) {
    return this.prisma.user.update({
      where: { id },
      data: { accountStatus },
      include: withEmployeeProfile,
    });
  }

  updateEmploymentStatus(id: string, employmentStatus: EmploymentStatus) {
    return this.prisma.user.update({
      where: { id },
      data: { employeeProfile: { update: { employmentStatus } } },
      include: withEmployeeProfile,
    });
  }

  updatePasswordHash(id: string, passwordHash: string) {
    return this.prisma.user.update({ where: { id }, data: { passwordHash } });
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
      include: withEmployeeProfile,
    });
  }
}

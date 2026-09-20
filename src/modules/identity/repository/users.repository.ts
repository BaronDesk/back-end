import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { UserRole } from '../../../generated/prisma/index.js';

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

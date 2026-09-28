import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { MachineStatus } from '../../../generated/prisma/index.js';

const PROVISIONAL_BRANCH_NAME = 'Provisional (unenrolled stations)';

@Injectable()
export class MachinesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findBySerial(serialNumber: string) {
    return this.prisma.machine.findUnique({ where: { serialNumber } });
  }

  findById(id: string) {
    return this.prisma.machine.findUnique({ where: { id } });
  }

  /** `branchId: null` means every branch (hq). */
  list(branchId: string | null) {
    return this.prisma.machine.findMany({
      where: branchId ? { branchId } : {},
      orderBy: { serialNumber: 'asc' },
    });
  }

  /**
   * Dev-only: registers an unknown station so it can be tracked before real
   * enrollment exists. Parks it on the oldest branch, or a placeholder one.
   */
  async createProvisional(serialNumber: string, name: string | null) {
    const branch =
      (await this.prisma.branch.findFirst({ orderBy: { createdAt: 'asc' } })) ??
      (await this.prisma.branch.create({ data: { name: PROVISIONAL_BRANCH_NAME, location: 'unknown' } }));

    return this.prisma.machine.upsert({
      where: { serialNumber },
      update: {},
      create: {
        serialNumber,
        name,
        branchId: branch.id,
        agentPublicKey: '',
        enrollmentStatus: 'PENDING',
      },
    });
  }

  markOnline(id: string, data: { lastSeen: Date; ipAddress: string | null; name: string | null }) {
    return this.prisma.machine.update({
      where: { id },
      data: {
        status: 'ONLINE',
        lastSeen: data.lastSeen,
        ipAddress: data.ipAddress,
        ...(data.name ? { name: data.name } : {}),
      },
    });
  }

  setStatus(id: string, status: MachineStatus, lastSeen: Date) {
    return this.prisma.machine.update({ where: { id }, data: { status, lastSeen } });
  }

  touchLastSeen(id: string, lastSeen: Date) {
    return this.prisma.machine.update({ where: { id }, data: { lastSeen } });
  }

  findStaleOnline(before: Date) {
    return this.prisma.machine.findMany({
      where: { status: 'ONLINE', OR: [{ lastSeen: null }, { lastSeen: { lt: before } }] },
    });
  }
}

import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { MachineStatus, Prisma } from '../../../generated/prisma/index.js';

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

  setPeripherals(id: string, peripherals: Prisma.InputJsonValue, reportedAt: Date) {
    return this.prisma.machine.update({ where: { id }, data: { peripherals, peripheralsReportedAt: reportedAt } });
  }

  rename(id: string, name: string) {
    return this.prisma.machine.update({ where: { id }, data: { name } });
  }

  findStaleOnline(before: Date) {
    return this.prisma.machine.findMany({
      where: { status: 'ONLINE', OR: [{ lastSeen: null }, { lastSeen: { lt: before } }] },
    });
  }
}

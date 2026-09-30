import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { MachineEnrollmentStatus } from '../../../generated/prisma/index.js';

@Injectable()
export class MachinesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string) {
    return this.prisma.machine.findUnique({ where: { id } });
  }

  findBySerialNumber(serialNumber: string) {
    return this.prisma.machine.findUnique({ where: { serialNumber } });
  }

  create(data: { serialNumber: string; branchId: string; agentPublicKey: string; name: string | null }) {
    return this.prisma.machine.create({
      data: { ...data, enrollmentStatus: 'PENDING' },
    });
  }

  rotateCredential(id: string, agentPublicKey: string) {
    return this.prisma.machine.update({ where: { id }, data: { agentPublicKey } });
  }

  updateStatus(id: string, enrollmentStatus: MachineEnrollmentStatus) {
    return this.prisma.machine.update({ where: { id }, data: { enrollmentStatus } });
  }

  list(where: { branchId?: string; enrollmentStatus?: MachineEnrollmentStatus }) {
    return this.prisma.machine.findMany({ where, orderBy: { createdAt: 'desc' } });
  }
}

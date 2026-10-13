import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import { Prisma } from '../../../generated/prisma/index.js';

@Injectable()
export class StationPolicyRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** A machine's own policy and its branch's default, or null for an unknown machine. */
  findForMachine(machineId: string) {
    return this.prisma.machine.findUnique({
      where: { id: machineId },
      select: { policy: true, branch: { select: { stationPolicy: true } } },
    });
  }

  /** The branch's default policy, or undefined for an unknown branch. */
  async findBranchPolicy(branchId: string): Promise<Prisma.JsonValue | undefined> {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId }, select: { stationPolicy: true } });
    return branch ? branch.stationPolicy : undefined;
  }

  /** Null clears it. */
  async setBranchPolicy(branchId: string, policy: Prisma.InputJsonValue | null): Promise<void> {
    await this.prisma.branch.update({ where: { id: branchId }, data: { stationPolicy: policy ?? Prisma.DbNull } });
  }
}

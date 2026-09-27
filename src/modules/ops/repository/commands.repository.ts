import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { CommandStatus, CommandType, Prisma } from '../../../generated/prisma/index.js';

@Injectable()
export class CommandsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  create(data: {
    id: string;
    machineId: string;
    branchId: string;
    type: CommandType;
    issuedBy: string;
    gameId?: string;
  }) {
    return this.prisma.command.create({ data });
  }

  /** An undelivered command of this type is already on its way to the machine. */
  async hasOpen(machineId: string, type: CommandType): Promise<boolean> {
    const open = await this.prisma.command.findFirst({
      where: { machineId, type, status: { in: ['PENDING', 'SENT'] } },
      select: { id: true },
    });
    return open !== null;
  }

  findById(id: string) {
    return this.prisma.command.findUnique({ where: { id } });
  }

  listForMachine(machineId: string, limit: number) {
    return this.prisma.command.findMany({ where: { machineId }, orderBy: { issuedAt: 'desc' }, take: limit });
  }

  /**
   * Compare-and-set on status: applies `data` only while the row is still in
   * one of `from`. Returns the updated row, or null when another path (a late
   * ack, the timeout, a retry) already moved it on. This is what keeps a
   * terminal status from ever being overwritten.
   */
  async transition(id: string, from: CommandStatus[], data: Prisma.CommandUpdateManyMutationInput) {
    const { count } = await this.prisma.command.updateMany({ where: { id, status: { in: from } }, data });
    return count ? this.prisma.command.findUnique({ where: { id } }) : null;
  }
}

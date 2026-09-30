import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

@Injectable()
export class EnrollmentTokensRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  create(data: {
    tokenHash: string;
    branchId: string;
    machineId: string | null;
    issuedById: string;
    expiresAt: Date;
  }) {
    return this.prisma.enrollmentToken.create({ data });
  }

  findByHash(tokenHash: string) {
    return this.prisma.enrollmentToken.findUnique({ where: { tokenHash } });
  }

  // Conditional so two concurrent polls can't both burn (and both be answered with) the same token.
  async consume(id: string): Promise<boolean> {
    const { count } = await this.prisma.enrollmentToken.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }

  bindMachine(id: string, machineId: string) {
    return this.prisma.enrollmentToken.update({ where: { id }, data: { machineId } });
  }
}

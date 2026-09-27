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
    return (this.prisma as any).enrollmentToken.create({ data });
  }

  findByHash(tokenHash: string) {
    return (this.prisma as any).enrollmentToken.findUnique({ where: { tokenHash } });
  }

  consume(id: string) {
    return (this.prisma as any).enrollmentToken.update({ where: { id }, data: { consumedAt: new Date() } });
  }
}

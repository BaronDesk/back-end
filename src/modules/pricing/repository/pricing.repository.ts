import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

export interface UpsertPricingInput {
  branchId: string;
  paygRate: number;
  bookingRate: number;
}

@Injectable()
export class PricingRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByBranchId(branchId: string) {
    return this.prisma.pricing.findFirst({
      where: { branchId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async upsertForBranch(input: UpsertPricingInput) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.pricing.findFirst({ where: { branchId: input.branchId } });

      const data = { paygRate: input.paygRate, bookingRate: input.bookingRate };

      if (existing) {
        return tx.pricing.update({ where: { id: existing.id }, data });
      }
      return tx.pricing.create({ data: { branchId: input.branchId, ...data } });
    });
  }
}

import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

export interface UpsertPricingInput {
  paygRate: number;
  bookingRate: number;
}

/** The pricing table holds a single row (id 1): the price list of every branch. */
const PRICING_ID = 1;

@Injectable()
export class PricingRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  find() {
    return this.prisma.pricing.findUnique({ where: { id: PRICING_ID } });
  }

  upsert(input: UpsertPricingInput) {
    return this.prisma.pricing.upsert({
      where: { id: PRICING_ID },
      update: input,
      create: { id: PRICING_ID, ...input },
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { PricingRepository } from '../repository/pricing.repository.js';
import type { UpsertPricingDto } from '../schemas/pricing.schemas.js';
import { toPublicPricing } from '../util/public-pricing.js';

@Injectable()
export class PricingService {
  constructor(private readonly pricing: PricingRepository) {}

  async getForBranch(branchId: string, caller: AccessTokenPayload) {
    assertScope(caller, { branchId });

    const row = await this.pricing.findByBranchId(branchId);
    if (!row) {
      throw new NotFoundException({ code: 'PRICING_NOT_SET', error: 'no pricing configured for this branch' });
    }
    return toPublicPricing(row);
  }

  async upsertForBranch(branchId: string, dto: UpsertPricingDto, caller: AccessTokenPayload) {
    assertScope(caller, { branchId });

    try {
      const row = await this.pricing.upsertForBranch({ branchId, ...dto });
      return toPublicPricing(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new NotFoundException({ code: 'BRANCH_NOT_FOUND', error: 'branch not found' });
      }
      throw err;
    }
  }
}
import { Injectable, NotFoundException } from '@nestjs/common';

import { PricingRepository } from '../repository/pricing.repository.js';
import type { UpsertPricingDto } from '../schemas/pricing.schemas.js';
import { toPublicPricing } from '../util/public-pricing.js';

const notSet = () => new NotFoundException({ code: 'PRICING_NOT_SET', error: 'no pricing configured yet' });

@Injectable()
export class PricingService {
  constructor(private readonly pricing: PricingRepository) {}

  async get() {
    const row = await this.pricing.find();
    if (!row) throw notSet();
    return toPublicPricing(row);
  }

  async upsert(dto: UpsertPricingDto) {
    return toPublicPricing(await this.pricing.upsert(dto));
  }

  /** The rates alone, for session-billing pricing a session. */
  async getRates() {
    const row = await this.pricing.find();
    if (!row) throw notSet();
    return { paygRate: row.paygRate, bookingRate: row.bookingRate };
  }
}

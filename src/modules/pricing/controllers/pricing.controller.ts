import { Body, Controller, Get, Put } from '@nestjs/common';

import { AuditLogService } from '../../../common/audit/audit-log.service.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { upsertPricingSchema, type UpsertPricingDto } from '../schemas/pricing.schemas.js';
import { PricingService } from '../services/pricing.service.js';

/** The play prices, in coins per hour: one price list for every branch. */
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricing: PricingService,
    private readonly audit: AuditLogService,
  ) {}

  // anyone signed in can see the prices
  @RequireScope('self')
  @Get()
  get() {
    return this.pricing.get();
  }

  // they apply in every branch, so only HQ changes them
  @RequireScope('hq')
  @Put()
  async upsert(@CurrentUser() caller: AccessTokenPayload, @Body(new ZodValidationPipe(upsertPricingSchema)) dto: UpsertPricingDto) {
    const saved = await this.pricing.upsert(dto);
    await this.audit.record(caller.sub, 'UPDATE', 'pricing', { metadata: { paygRate: dto.paygRate, bookingRate: dto.bookingRate } });
    return saved;
  }
}

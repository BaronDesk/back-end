import { Body, Controller, Get, Param, Put } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  branchIdParamSchema, upsertPricingSchema, type UpsertPricingDto,
} from '../schemas/pricing.schemas.js';
import { PricingService } from '../services/pricing.service.js';

@Controller('branches/:branchId/pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  // employees can view their own branch's rates
  @RequireScope('staff')
  @Get()
  get(
    @Param('branchId', new ZodValidationPipe(branchIdParamSchema)) branchId: string,
    @CurrentUser() caller: AccessTokenPayload,
  ) {
    return this.pricing.getForBranch(branchId, caller);
  }

  // only managers/admins can change rates
  @RequireScope('admin')
  @Put()
  upsert(
    @Param('branchId', new ZodValidationPipe(branchIdParamSchema)) branchId: string,
    @Body(new ZodValidationPipe(upsertPricingSchema)) dto: UpsertPricingDto,
    @CurrentUser() caller: AccessTokenPayload,
  ) {
    return this.pricing.upsertForBranch(branchId, dto, caller);
  }
}
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  createSubscriptionPlanSchema,
  idParamSchema,
  purchaseSubscriptionSchema,
  updateSubscriptionPlanSchema,
  type CreateSubscriptionPlanDto,
  type PurchaseSubscriptionDto,
  type UpdateSubscriptionPlanDto,
} from '../schemas/subscription.schemas.js';
import { SubscriptionsService } from '../services/subscriptions.service.js';

@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @RequireScope('self')
  @Get('subscription-plans')
  listPlans() {
    return this.subscriptions.listPlans();
  }

  @RequireScope('admin')
  @Post('subscription-plans')
  createPlan(
    @Body(new ZodValidationPipe(createSubscriptionPlanSchema))
    dto: CreateSubscriptionPlanDto,
  ) {
    return this.subscriptions.createPlan(dto);
  }

  @RequireScope('admin')
  @Patch('subscription-plans/:id')
  updatePlan(
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateSubscriptionPlanSchema))
    dto: UpdateSubscriptionPlanDto,
  ) {
    return this.subscriptions.updatePlan(id, dto);
  }

  @RequireScope('admin')
  @Delete('subscription-plans/:id')
  deletePlan(@Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.subscriptions.deletePlan(id);
  }

  @RequireScope('self')
  @Get('subscriptions/me')
  listMine(@CurrentUser() caller: AccessTokenPayload) {
    return this.subscriptions.listMine(caller);
  }

  @RequireScope('self')
  @Post('subscription-plans/:id/purchase')
  purchase(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(purchaseSubscriptionSchema))
    dto: PurchaseSubscriptionDto,
  ) {
    return this.subscriptions.purchase(caller, id, dto);
  }
}

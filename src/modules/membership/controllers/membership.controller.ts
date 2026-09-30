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
  createMembershipPlanSchema,
  idParamSchema,
  purchaseMembershipSchema,
  updateMembershipPlanSchema,
  type CreateMembershipPlanDto,
  type PurchaseMembershipDto,
  type UpdateMembershipPlanDto,
} from '../schemas/membership.schemas.js';
import { MembershipService } from '../services/membership.service.js';

@Controller()
export class MembershipController {
  constructor(private readonly memberships: MembershipService) {}

  @RequireScope('self')
  @Get('membership-plans')
  listPlans() {
    return this.memberships.listPlans();
  }

  @RequireScope('admin')
  @Post('membership-plans')
  createPlan(
    @Body(new ZodValidationPipe(createMembershipPlanSchema))
    dto: CreateMembershipPlanDto,
  ) {
    return this.memberships.createPlan(dto);
  }

  @RequireScope('admin')
  @Patch('membership-plans/:id')
  updatePlan(
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateMembershipPlanSchema))
    dto: UpdateMembershipPlanDto,
  ) {
    return this.memberships.updatePlan(id, dto);
  }

  @RequireScope('admin')
  @Delete('membership-plans/:id')
  deletePlan(@Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.memberships.deletePlan(id);
  }

  @RequireScope('self')
  @Get('memberships/me')
  listMine(@CurrentUser() caller: AccessTokenPayload) {
    return this.memberships.listMine(caller);
  }

  /** Ends the gamer's active membership now (no refund). */
  @RequireScope('self')
  @Post('memberships/me/cancel')
  cancelMine(@CurrentUser() caller: AccessTokenPayload) {
    return this.memberships.cancelMine(caller);
  }

  @RequireScope('self')
  @Post('membership-plans/:id/purchase')
  purchase(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(purchaseMembershipSchema))
    dto: PurchaseMembershipDto,
  ) {
    return this.memberships.purchase(caller, id, dto);
  }
}

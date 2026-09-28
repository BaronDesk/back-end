import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/index.js';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { SubscriptionsRepository } from '../repository/subscriptions.repository.js';
import type {
  CreateSubscriptionPlanDto,
  PurchaseSubscriptionDto,
  UpdateSubscriptionPlanDto,
} from '../schemas/subscription.schemas.js';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly subscriptions: SubscriptionsRepository) {}

  listPlans() {
    return this.subscriptions.listPlans();
  }

  async createPlan(dto: CreateSubscriptionPlanDto) {
    try {
      return await this.subscriptions.createPlan(dto);
    } catch (error) {
      this.translatePlanError(error);
    }
  }

  async updatePlan(id: string, dto: UpdateSubscriptionPlanDto) {
    try {
      return await this.subscriptions.updatePlan(id, dto);
    } catch (error) {
      this.translatePlanError(error);
    }
  }

  async deletePlan(id: string) {
    try {
      return await this.subscriptions.deletePlan(id);
    } catch (error) {
      this.translatePlanError(error);
    }
  }

  async listMine(caller: AccessTokenPayload) {
    return this.subscriptions.listForGamer(
      await this.resolveGamerProfileId(caller),
    );
  }

  async purchase(
    caller: AccessTokenPayload,
    planId: string,
    dto: PurchaseSubscriptionDto,
  ) {
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    try {
      const result = await this.subscriptions.purchase(
        gamerProfileId,
        planId,
        dto.idempotencyKey,
      );
      if ('kind' in result) {
        if (result.kind === 'PLAN_NOT_FOUND') {
          throw new NotFoundException({
            code: 'SUBSCRIPTION_PLAN_NOT_FOUND',
            error: 'subscription plan not found',
          });
        }
        throw new ConflictException({
          code: 'INSUFFICIENT_FUNDS',
          error: 'wallet balance is insufficient',
        });
      }
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        dto.idempotencyKey
      ) {
        const existing = (
          await this.subscriptions.listForGamer(gamerProfileId)
        ).find(
          (subscription) => subscription.idempotencyKey === dto.idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async resolveGamerProfileId(caller: AccessTokenPayload) {
    const id = await this.subscriptions.findGamerProfileIdByUserId(caller.sub);
    if (!id)
      throw new NotFoundException({
        code: 'GAMER_PROFILE_NOT_FOUND',
        error: 'caller has no gamer profile',
      });
    return id;
  }

  private translatePlanError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        throw new NotFoundException({
          code: 'SUBSCRIPTION_PLAN_NOT_FOUND',
          error: 'subscription plan not found',
        });
      }
      if (error.code === 'P2002') {
        throw new ConflictException({
          code: 'SUBSCRIPTION_PLAN_NAME_TAKEN',
          error: 'subscription plan name already exists',
        });
      }
      if (error.code === 'P2003') {
        throw new ConflictException({
          code: 'SUBSCRIPTION_PLAN_IN_USE',
          error: 'subscription plan has subscription history',
        });
      }
    }
    throw error;
  }
}

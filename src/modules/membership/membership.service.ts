import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/index.js';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { MembershipRepository } from './membership.repository.js';
import type {
  CreateMembershipPlanDto,
  PurchaseMembershipDto,
  UpdateMembershipPlanDto,
} from './membership.schemas.js';

@Injectable()
export class MembershipService {
  constructor(private readonly memberships: MembershipRepository) {}

  listPlans() {
    return this.memberships.listPlans();
  }

  async createPlan(dto: CreateMembershipPlanDto) {
    try {
      return await this.memberships.createPlan(dto);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'MEMBERSHIP_PLAN_NAME_TAKEN',
          error: 'membership plan name already exists',
        });
      }
      throw error;
    }
  }

  async updatePlan(id: string, dto: UpdateMembershipPlanDto) {
    try {
      return await this.memberships.updatePlan(id, dto);
    } catch (error) {
      this.translatePlanError(error);
    }
  }

  async deletePlan(id: string) {
    try {
      return await this.memberships.deletePlan(id);
    } catch (error) {
      this.translatePlanError(error);
    }
  }

  async listMine(caller: AccessTokenPayload) {
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    return this.memberships.listForGamer(gamerProfileId);
  }

  async purchase(
    caller: AccessTokenPayload,
    planId: string,
    dto: PurchaseMembershipDto,
  ) {
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    try {
      const result = await this.memberships.purchase(
        gamerProfileId,
        planId,
        dto.idempotencyKey,
      );
      if ('kind' in result) {
        if (result.kind === 'PLAN_NOT_FOUND') {
          throw new NotFoundException({
            code: 'MEMBERSHIP_PLAN_NOT_FOUND',
            error: 'membership plan not found',
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
          await this.memberships.listForGamer(gamerProfileId)
        ).find(
          (membership) => membership.idempotencyKey === dto.idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async resolveGamerProfileId(caller: AccessTokenPayload) {
    const id = await this.memberships.findGamerProfileIdByUserId(caller.sub);
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
          code: 'MEMBERSHIP_PLAN_NOT_FOUND',
          error: 'membership plan not found',
        });
      }
      if (error.code === 'P2002') {
        throw new ConflictException({
          code: 'MEMBERSHIP_PLAN_NAME_TAKEN',
          error: 'membership plan name already exists',
        });
      }
      if (error.code === 'P2003') {
        throw new ConflictException({
          code: 'MEMBERSHIP_PLAN_IN_USE',
          error: 'membership plan has active history',
        });
      }
    }
    throw error;
  }
}

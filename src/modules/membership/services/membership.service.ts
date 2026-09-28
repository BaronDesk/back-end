import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/index.js';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { MembershipRepository } from '../repository/membership.repository.js';
import type {
  CreateMembershipPlanDto,
  PurchaseMembershipDto,
  UpdateMembershipPlanDto,
} from '../schemas/membership.schemas.js';

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const startOfUtcDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const alreadyActive = () =>
  new ConflictException({
    code: 'MEMBERSHIP_ALREADY_ACTIVE',
    error: 'gamer already has an active membership',
  });

@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    private readonly memberships: MembershipRepository,
    private readonly wallet: WalletService,
  ) {}

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

  /*
   * validate plan + eligibility -> debit through WalletService -> create membership row.
   * the wallet module is the only ledger writer, so a failed insert is compensated with
   * a REFUND credit instead of a shared transaction.
   */
  async purchase(
    caller: AccessTokenPayload,
    planId: string,
    dto: PurchaseMembershipDto,
  ) {
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    const key = dto.idempotencyKey;

    if (key) {
      const previous = await this.memberships.findByIdempotencyKey(
        gamerProfileId,
        key,
      );
      if (previous) return previous;
    }

    const plan = await this.memberships.findPlan(planId);
    if (!plan) {
      throw new NotFoundException({
        code: 'MEMBERSHIP_PLAN_NOT_FOUND',
        error: 'membership plan not found',
      });
    }

    const now = new Date();
    await this.memberships.expireLapsed(gamerProfileId, startOfUtcDay(now));
    if (await this.memberships.findActiveForGamer(gamerProfileId)) {
      throw alreadyActive();
    }

    const price = Math.round(Number(plan.price) * 100);
    const ledgerKey = `membership:${key ?? randomUUID()}`;
    if (price > 0) {
      await this.wallet.debit(gamerProfileId, {
        amount: price,
        type: 'PAYMENT',
        idempotencyKey: ledgerKey,
      });
    }

    try {
      return await this.memberships.create({
        gamerProfileId,
        membershipPlanId: plan.id,
        discountPercentSnapshot: plan.discountPercent,
        idempotencyKey: key,
        startDate: now,
        endDate: new Date(now.getTime() + plan.durationDays * 86_400_000),
      });
    } catch (error) {
      const uniqueViolation = isUniqueViolation(error);
      // a concurrent retry with the same key won the insert and shares this debit: no refund
      if (key && uniqueViolation) {
        const winner = await this.memberships.findByIdempotencyKey(
          gamerProfileId,
          key,
        );
        if (winner) return winner;
      }

      if (price > 0) await this.refund(gamerProfileId, price, ledgerKey);
      // otherwise the one-active partial unique index caught a concurrent purchase
      if (uniqueViolation) throw alreadyActive();
      throw error;
    }
  }

  private async refund(gamerProfileId: string, amount: number, ledgerKey: string) {
    try {
      await this.wallet.credit(gamerProfileId, {
        amount,
        type: 'REFUND',
        idempotencyKey: `${ledgerKey}:refund`,
      });
    } catch (error) {
      this.logger.error(
        `membership purchase refund failed for gamer ${gamerProfileId} (${ledgerKey})`,
        error instanceof Error ? error.stack : String(error),
      );
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

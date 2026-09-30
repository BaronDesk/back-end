import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/prisma/index.js';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { dinarsToMillimes } from '../../../common/utils/money.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { SubscriptionsRepository } from '../repository/subscriptions.repository.js';
import {
  benefitsSchema,
  type CreateSubscriptionPlanDto,
  type PurchaseSubscriptionDto,
  type UpdateSubscriptionPlanDto,
} from '../schemas/subscription.schemas.js';
import { inWindow, localClock } from '../util/benefit-window.js';

const startOfUtcDay = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly timeZone: string;

  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly wallet: WalletService,
    config: ConfigService,
  ) {
    this.timeZone = config.get<string>('BUSINESS_TIMEZONE') ?? 'Africa/Tunis';
  }

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
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    await this.subscriptions.expireLapsed(gamerProfileId, startOfUtcDay(new Date()));
    return this.subscriptions.listForGamer(gamerProfileId);
  }

  /**
   * Internal accessor: the best discount the gamer's active passes give at
   * `at` (local business time), or null outside every window. Benefits not in
   * the `windows` shape grant nothing.
   */
  async getWindowDiscountForGamer(gamerProfileId: string, at = new Date()): Promise<{ subscriptionId: string; discountPercent: number } | null> {
    const today = startOfUtcDay(at);
    await this.subscriptions.expireLapsed(gamerProfileId, today);
    const clock = localClock(at, this.timeZone);
    let best: { subscriptionId: string; discountPercent: number } | null = null;
    for (const sub of await this.subscriptions.findActiveForGamer(gamerProfileId, today)) {
      const benefits = benefitsSchema.safeParse(sub.benefitsSnapshot);
      if (!benefits.success) continue;
      for (const window of benefits.data.windows) {
        if (inWindow(window, clock) && window.discountPercent > (best?.discountPercent ?? 0)) {
          best = { subscriptionId: sub.id, discountPercent: window.discountPercent };
        }
      }
    }
    return best;
  }

  async purchase(
    caller: AccessTokenPayload,
    planId: string,
    dto: PurchaseSubscriptionDto,
  ) {
    const gamerProfileId = await this.resolveGamerProfileId(caller);
    const key = dto.idempotencyKey;

    if (key) {
      const previous = await this.subscriptions.findByIdempotencyKey(
        gamerProfileId,
        key,
      );
      if (previous) return previous;
    }

    const plan = await this.subscriptions.findPlan(planId);
    if (!plan) {
      throw new NotFoundException({
        code: 'SUBSCRIPTION_PLAN_NOT_FOUND',
        error: 'subscription plan not found',
      });
    }

    const today = startOfUtcDay(new Date());
    await this.subscriptions.expireLapsed(gamerProfileId, today);
    const active = await this.subscriptions.findActiveForGamer(gamerProfileId, today);
    if (active.some((s) => s.subscriptionPlanId === plan.id)) {
      throw new ConflictException({ code: 'SUBSCRIPTION_ALREADY_ACTIVE', error: 'gamer already has this pass' });
    }

    const price = dinarsToMillimes(plan.price);
    const ledgerKey = `subscription:${key ?? randomUUID()}`;
    if (price > 0) {
      await this.wallet.debit(gamerProfileId, {
        amount: price,
        type: 'PAYMENT',
        idempotencyKey: ledgerKey,
      });
    }

    const now = new Date();
    try {
      return await this.subscriptions.create({
        gamerProfileId,
        subscriptionPlanId: plan.id,
        benefitsSnapshot: plan.benefits as Prisma.InputJsonValue,
        idempotencyKey: key,
        startDate: now,
        endDate: new Date(now.getTime() + plan.durationDays * 86_400_000),
      });
    } catch (error) {
      // a concurrent retry with the same key won the insert and shares this debit: no refund
      if (
        key &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.subscriptions.findByIdempotencyKey(
          gamerProfileId,
          key,
        );
        if (winner) return winner;
      }
      if (price > 0) await this.refund(gamerProfileId, price, ledgerKey);
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
        `subscription purchase refund failed for gamer ${gamerProfileId} (${ledgerKey})`,
        error instanceof Error ? error.stack : String(error),
      );
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

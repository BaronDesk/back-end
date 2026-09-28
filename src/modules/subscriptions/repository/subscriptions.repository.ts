import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/index.js';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from '../schemas/subscription.schemas.js';

@Injectable()
export class SubscriptionsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  listPlans() {
    return this.prisma.subscriptionPlan.findMany({ orderBy: { price: 'asc' } });
  }

  createPlan(dto: CreateSubscriptionPlanDto) {
    return this.prisma.subscriptionPlan.create({ data: dto });
  }

  updatePlan(id: string, dto: UpdateSubscriptionPlanDto) {
    return this.prisma.subscriptionPlan.update({ where: { id }, data: dto });
  }

  deletePlan(id: string) {
    return this.prisma.subscriptionPlan.delete({ where: { id } });
  }

  findGamerProfileIdByUserId(userId: string) {
    return this.prisma.gamerProfile
      .findUnique({ where: { userId }, select: { id: true } })
      .then((row) => row?.id ?? null);
  }

  listForGamer(gamerProfileId: string) {
    return this.prisma.subscription.findMany({
      where: { gamerProfileId },
      include: { subscriptionPlan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async purchase(
    gamerProfileId: string,
    planId: string,
    idempotencyKey?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.subscription.findUnique({
          where: {
            gamerProfileId_idempotencyKey: { gamerProfileId, idempotencyKey },
          },
          include: { subscriptionPlan: true },
        });
        if (existing) return existing;
      }

      const plan = await tx.subscriptionPlan.findUnique({
        where: { id: planId },
      });
      if (!plan) return { kind: 'PLAN_NOT_FOUND' as const };

      const priceInMinorUnits = Math.round(Number(plan.price) * 100);
      const wallet = await tx.wallet.upsert({
        where: { gamerProfileId },
        create: { gamerProfileId },
        update: {},
      });
      const [updated] = await tx.$queryRaw<{ balance: number }[]>`
        UPDATE wallets SET balance = balance - ${priceInMinorUnits}::integer, updated_at = now()
        WHERE id = ${wallet.id}::uuid AND balance >= ${priceInMinorUnits}::integer
        RETURNING balance
      `;
      if (!updated) return { kind: 'INSUFFICIENT_FUNDS' as const };

      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          amount: -priceInMinorUnits,
          balanceAfter: updated.balance,
          type: 'DEBIT',
          idempotencyKey: idempotencyKey
            ? `subscription:${idempotencyKey}`
            : undefined,
        },
      });

      const now = new Date();
      return tx.subscription.create({
        data: {
          gamerProfileId,
          subscriptionPlanId: plan.id,
          benefitsSnapshot: plan.benefits as Prisma.InputJsonValue,
          idempotencyKey,
          startDate: now,
          endDate: new Date(now.getTime() + plan.durationDays * 86_400_000),
        },
        include: { subscriptionPlan: true },
      });
    });
  }
}

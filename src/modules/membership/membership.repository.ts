import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/index.js';

import { BaseRepository } from '../../common/repository/base.repository.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type {
  CreateMembershipPlanDto,
  UpdateMembershipPlanDto,
} from './membership.schemas.js';

@Injectable()
export class MembershipRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  listPlans() {
    return this.prisma.membershipPlan.findMany({ orderBy: { price: 'asc' } });
  }

  findPlan(id: string) {
    return this.prisma.membershipPlan.findUnique({ where: { id } });
  }

  createPlan(data: CreateMembershipPlanDto) {
    return this.prisma.membershipPlan.create({ data });
  }

  updatePlan(id: string, data: UpdateMembershipPlanDto) {
    return this.prisma.membershipPlan.update({ where: { id }, data });
  }

  deletePlan(id: string) {
    return this.prisma.membershipPlan.delete({ where: { id } });
  }

  listForGamer(gamerProfileId: string) {
    return this.prisma.membership.findMany({
      where: { gamerProfileId },
      include: { membershipPlan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  findGamerProfileIdByUserId(userId: string) {
    return this.prisma.gamerProfile
      .findUnique({ where: { userId }, select: { id: true } })
      .then((p) => p?.id ?? null);
  }

  async purchase(
    gamerProfileId: string,
    planId: string,
    idempotencyKey?: string,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        if (idempotencyKey) {
          const previous = await tx.membership.findUnique({
            where: {
              gamerProfileId_idempotencyKey: { gamerProfileId, idempotencyKey },
            },
            include: { membershipPlan: true },
          });
          if (previous) return previous;
        }

        const plan = await tx.membershipPlan.findUnique({
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

        const entry = await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            amount: -priceInMinorUnits,
            balanceAfter: updated.balance,
            type: 'DEBIT',
            idempotencyKey: idempotencyKey
              ? `membership:${idempotencyKey}`
              : undefined,
          },
        });
        const now = new Date();
        const membership = await tx.membership.create({
          data: {
            gamerProfileId,
            membershipPlanId: plan.id,
            discountPercentSnapshot: plan.discountPercent,
            idempotencyKey,
            startDate: now,
            endDate: new Date(now.getTime() + plan.durationDays * 86_400_000),
          },
          include: { membershipPlan: true },
        });
        return { ...membership, purchaseLedgerEntryId: entry.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

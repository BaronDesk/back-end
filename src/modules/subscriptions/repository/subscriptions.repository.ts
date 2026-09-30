import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/index.js';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from '../schemas/subscription.schemas.js';

export interface CreateSubscriptionInput {
  gamerProfileId: string;
  subscriptionPlanId: string;
  benefitsSnapshot: Prisma.InputJsonValue;
  idempotencyKey?: string;
  startDate: Date;
  endDate: Date;
}

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

  findPlan(id: string) {
    return this.prisma.subscriptionPlan.findUnique({ where: { id } });
  }

  findByIdempotencyKey(gamerProfileId: string, idempotencyKey: string) {
    return this.prisma.subscription.findUnique({
      where: {
        gamerProfileId_idempotencyKey: { gamerProfileId, idempotencyKey },
      },
      include: { subscriptionPlan: true },
    });
  }

  /** ACTIVE passes whose end date is today or later (end dates are whole days). */
  findActiveForGamer(gamerProfileId: string, today: Date) {
    return this.prisma.subscription.findMany({
      where: { gamerProfileId, status: 'ACTIVE', startDate: { lte: today }, endDate: { gte: today } },
    });
  }

  // flips ACTIVE passes whose end date has passed, so they neither apply nor block a new purchase
  expireLapsed(gamerProfileId: string, today: Date) {
    return this.prisma.subscription.updateMany({
      where: { gamerProfileId, status: 'ACTIVE', endDate: { lt: today } },
      data: { status: 'EXPIRED' },
    });
  }

  create(data: CreateSubscriptionInput) {
    return this.prisma.subscription.create({
      data,
      include: { subscriptionPlan: true },
    });
  }
}

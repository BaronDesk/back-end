import { Injectable } from '@nestjs/common';
import { Prisma, type MembershipStatus } from '../../../generated/prisma/index.js';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type {
  CreateMembershipPlanDto,
  UpdateMembershipPlanDto,
} from '../schemas/membership.schemas.js';

export interface CreateMembershipInput {
  gamerProfileId: string;
  membershipPlanId: string;
  discountPercentSnapshot: Prisma.Decimal;
  idempotencyKey?: string;
  startDate: Date;
  endDate: Date;
}

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

  findByIdempotencyKey(gamerProfileId: string, idempotencyKey: string) {
    return this.prisma.membership.findUnique({
      where: {
        gamerProfileId_idempotencyKey: { gamerProfileId, idempotencyKey },
      },
      include: { membershipPlan: true },
    });
  }

  findActiveForGamer(gamerProfileId: string) {
    return this.prisma.membership.findFirst({
      where: { gamerProfileId, status: 'ACTIVE' },
      include: { membershipPlan: true },
    });
  }

  // flips ACTIVE memberships whose end date has passed so they stop blocking a new purchase
  expireLapsed(gamerProfileId: string, today: Date) {
    return this.prisma.membership.updateMany({
      where: { gamerProfileId, status: 'ACTIVE', endDate: { lt: today } },
      data: { status: 'EXPIRED' },
    });
  }

  setStatus(id: string, status: MembershipStatus) {
    return this.prisma.membership.update({ where: { id }, data: { status }, include: { membershipPlan: true } });
  }

  create(data: CreateMembershipInput) {
    return this.prisma.membership.create({
      data,
      include: { membershipPlan: true },
    });
  }
}

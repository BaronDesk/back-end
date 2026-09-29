import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { Prisma, SessionStatus } from '../../../generated/prisma/index.js';

export const OPEN_SESSION_STATUSES: SessionStatus[] = ['PENDING', 'ACTIVE', 'PAUSED'];

export interface CreateSessionInput {
  reservationId: string;
  appliedMembershipId: string | null;
  startTime: Date;
  endTime: Date;
  rateCentsPerMinute: number;
}

@Injectable()
export class SessionsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string) {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /** Settlement only needs the gamer to debit; presence's SessionEndedEvent already carries machine/branch. */
  findForSettlement(id: string) {
    return this.prisma.session.findUnique({
      where: { id },
      include: { reservation: { select: { gamerProfileId: true } } },
    });
  }

  findByIdWithReservation(id: string) {
    return this.prisma.session.findUnique({
      where: { id },
      include: { reservation: { include: { machine: true } } },
    });
  }

  findReservationForStart(reservationId: string) {
    return this.prisma.reservation.findUnique({ where: { id: reservationId }, include: { machine: true } });
  }

  findActiveForReservation(reservationId: string) {
    return this.prisma.session.findFirst({ where: { reservationId, status: { in: OPEN_SESSION_STATUSES } } });
  }

  create(data: CreateSessionInput) {
    return this.prisma.session.create({ data: { ...data, status: 'PENDING' } });
  }

  update(id: string, data: Prisma.SessionUpdateInput) {
    return this.prisma.session.update({ where: { id }, data });
  }
}

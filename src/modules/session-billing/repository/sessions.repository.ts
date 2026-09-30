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
  pinHash: string;
  pinExpiresAt: Date;
}

/** Settlement needs the gamer to debit; station checks need the reservation's machine. */
const WITH_STATION = { reservation: { select: { gamerProfileId: true, machineId: true } } } as const;

@Injectable()
export class SessionsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string) {
    return this.prisma.session.findUnique({ where: { id } });
  }

  findForSettlement(id: string) {
    return this.prisma.session.findUnique({ where: { id }, include: WITH_STATION });
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

  /** The ACTIVE session for a gamer, if any — reschedules on a wallet top-up. */
  findActiveByGamer(gamerProfileId: string) {
    return this.prisma.session.findFirst({
      where: { status: 'ACTIVE', reservation: { gamerProfileId } },
      include: { reservation: { include: { machine: true } } },
    });
  }

  create(data: CreateSessionInput) {
    return this.prisma.session.create({ data: { ...data, status: 'PENDING' } });
  }

  update(id: string, data: Prisma.SessionUpdateInput) {
    return this.prisma.session.update({ where: { id }, data });
  }

  /** The PENDING session a login on this station is for: its reservation is CONFIRMED and its window not over. */
  findLoginCandidate(machineId: string, now: Date) {
    return this.prisma.session.findFirst({
      where: { status: 'PENDING', endTime: { gt: now }, reservation: { machineId, status: 'CONFIRMED' } },
      orderBy: { startTime: 'asc' },
    });
  }

  /** Takes one PIN attempt, atomically; false once the attempts are used up or the PIN is spent. */
  async claimPinAttempt(id: string, maxAttempts: number): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id, status: 'PENDING', pinUsedAt: null, pinAttempts: { lt: maxAttempts } },
      data: { pinAttempts: { increment: 1 } },
    });
    return count === 1;
  }

  /** Marks the PIN spent and drops its hash; false if another login spent it first. */
  async spendPin(id: string, at: Date): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id, status: 'PENDING', pinUsedAt: null },
      data: { pinUsedAt: at, pinHash: null },
    });
    return count === 1;
  }

  /** Closes a PENDING session nobody logged into, expiring its PIN. */
  cancelPending(id: string) {
    return this.prisma.session.updateMany({
      where: { id, status: 'PENDING', pinUsedAt: null },
      data: { status: 'CANCELLED', pinHash: null },
    });
  }

  /** Session goes ACTIVE; its reservation CONFIRMED -> ACTIVE on first activation. */
  async activate(id: string, reservationId: string, data: Prisma.SessionUpdateInput) {
    await this.prisma.$transaction([
      this.prisma.session.update({ where: { id }, data }),
      this.prisma.reservation.updateMany({ where: { id: reservationId, status: 'CONFIRMED' }, data: { status: 'ACTIVE' } }),
    ]);
  }

  /** Session settles; its reservation -> COMPLETED. */
  async complete(id: string, reservationId: string, data: Prisma.SessionUpdateInput) {
    await this.prisma.$transaction([
      this.prisma.session.update({ where: { id }, data }),
      this.prisma.reservation.updateMany({
        where: { id: reservationId, status: { in: ['CONFIRMED', 'ACTIVE'] } },
        data: { status: 'COMPLETED' },
      }),
    ]);
  }

  /** Open sessions whose reservation window is over. */
  findOverdueOpen(now: Date) {
    return this.prisma.session.findMany({
      where: { status: { in: OPEN_SESSION_STATUSES }, endTime: { lte: now } },
      include: WITH_STATION,
    });
  }

  /** CONFIRMED reservations whose window passed without an accepted login -> NO_SHOW. */
  async markNoShows(now: Date): Promise<number> {
    const { count } = await this.prisma.reservation.updateMany({
      where: { status: 'CONFIRMED', endTime: { lte: now }, sessions: { none: { pinUsedAt: { not: null } } } },
      data: { status: 'NO_SHOW' },
    });
    return count;
  }
}

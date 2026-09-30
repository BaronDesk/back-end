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

  /** Any PENDING/ACTIVE/PAUSED session on this station; a station holds at most one. */
  findOpenSessionForMachine(machineId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).session.findFirst({
      where: { status: { in: OPEN_SESSION_STATUSES }, reservation: { machineId } },
    });
  }

  /**
   * Runs fn in one transaction holding the station's advisory lock — the same
   * lock reservations take — so check-then-create on a station is serialized.
   */
  withMachineLock<T>(machineId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${machineId}))`;
      return fn(tx);
    });
  }

  /** The ACTIVE session for a gamer, if any — reschedules on a wallet top-up. */
  findActiveByGamer(gamerProfileId: string) {
    return this.prisma.session.findFirst({
      where: { status: 'ACTIVE', reservation: { gamerProfileId } },
      include: { reservation: { include: { machine: true } } },
    });
  }

  create(data: CreateSessionInput, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).session.create({ data: { ...data, status: 'PENDING' } });
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
  cancelPending(id: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).session.updateMany({
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

  /**
   * Session settles; its reservation -> COMPLETED. Only an open session is
   * closed: false if another path (presence, force-close, sweep) closed it first.
   */
  complete(id: string, reservationId: string, data: Prisma.SessionUpdateManyMutationInput): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({ where: { id, status: { in: OPEN_SESSION_STATUSES } }, data });
      if (count === 0) return false;
      await tx.reservation.updateMany({
        where: { id: reservationId, status: { in: ['CONFIRMED', 'ACTIVE'] } },
        data: { status: 'COMPLETED' },
      });
      return true;
    });
  }

  /** Open sessions whose reservation window is over. */
  findOverdueOpen(now: Date) {
    return this.prisma.session.findMany({
      where: { status: { in: OPEN_SESSION_STATUSES }, endTime: { lte: now } },
      include: WITH_STATION,
    });
  }

  /**
   * Started reservations the gamer never logged into: the PIN expired unused
   * (the no-show grace) while the reservation is still CONFIRMED, window open or not.
   */
  findExpiredUnusedPins(now: Date) {
    return this.prisma.session.findMany({
      where: { status: 'PENDING', pinUsedAt: null, pinExpiresAt: { lte: now }, reservation: { status: 'CONFIRMED' } },
      select: { id: true, reservationId: true },
    });
  }

  /**
   * Early no-show, in one transaction: the unused-PIN session -> CANCELLED (PIN
   * hash dropped) and its CONFIRMED reservation -> NO_SHOW, freeing the station.
   * False if a login spent the PIN or the reservation moved on meanwhile.
   */
  expireAsNoShow(id: string, reservationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id, status: 'PENDING', pinUsedAt: null, reservation: { status: 'CONFIRMED' } },
        data: { status: 'CANCELLED', pinHash: null },
      });
      if (count === 0) return false;
      await tx.reservation.updateMany({ where: { id: reservationId, status: 'CONFIRMED' }, data: { status: 'NO_SHOW' } });
      return true;
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

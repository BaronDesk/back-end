import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { Prisma, SessionStatus } from '../../../generated/prisma/index.js';

export const OPEN_SESSION_STATUSES: SessionStatus[] = ['PENDING', 'ACTIVE', 'PAUSED'];

/** Reservations that hold their time slot (ACTIVE = a session is running on it). */
const HOLDING_RESERVATION_STATUSES = ['PENDING', 'CONFIRMED', 'ACTIVE'] as const;

export interface CreateSessionInput {
  reservationId: string;
  appliedMembershipId: string | null;
  startTime: Date;
  endTime: Date;
  rateCentsPerMinute: number;
  pinHash: string;
  pinExpiresAt: Date;
}

/** Settlement needs the gamer to debit; station checks and notices need the reservation's machine. */
const WITH_STATION = {
  reservation: {
    select: {
      gamerProfileId: true,
      machineId: true,
      isWalkIn: true,
      machine: { select: { serialNumber: true, branchId: true } },
    },
  },
} as const;

/** Open and logged into: the station may be unlocked for it (a PENDING one only once its PIN was used). */
const GRANTED: Prisma.SessionWhereInput = {
  status: { in: OPEN_SESSION_STATUSES },
  OR: [{ status: { not: 'PENDING' } }, { pinUsedAt: { not: null } }],
};

@Injectable()
export class SessionsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findById(id: string) {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /** Sessions for the staff app, newest first, with their station and gamer. */
  list(filter: { branchId: string | null; status?: SessionStatus; from?: Date; limit: number }) {
    return this.prisma.session.findMany({
      where: {
        ...(filter.branchId ? { reservation: { machine: { branchId: filter.branchId } } } : {}),
        ...(filter.status ? { status: filter.status } : { status: { not: 'CANCELLED' } }),
        ...(filter.from ? { startTime: { gte: filter.from } } : {}),
      },
      include: {
        reservation: {
          select: {
            machine: { select: { id: true, name: true, serialNumber: true, branchId: true } },
            gamerProfile: { select: { user: { select: { username: true } } } },
          },
        },
      },
      orderBy: { startTime: 'desc' },
      take: filter.limit,
    });
  }

  /** The gamer's own current session (logged into, still open), with its booking and station. */
  findCurrentForGamer(gamerProfileId: string) {
    return this.prisma.session.findFirst({
      where: { ...GRANTED, reservation: { gamerProfileId } },
      include: {
        reservation: {
          select: {
            id: true,
            gamerProfileId: true,
            machineId: true,
            isWalkIn: true,
            startTime: true,
            endTime: true,
            machine: { select: { id: true, name: true, serialNumber: true, branchId: true } },
          },
        },
      },
      orderBy: { startTime: 'desc' },
    });
  }

  gamerProfileIdForUser(userId: string) {
    return this.prisma.gamerProfile.findUnique({ where: { userId }, select: { id: true } }).then((p) => p?.id ?? null);
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

  /** The ACTIVE session for a gamer, if any — reschedules on a wallet change. */
  findActiveByGamer(gamerProfileId: string) {
    return this.prisma.session.findFirst({
      where: { status: 'ACTIVE', reservation: { gamerProfileId } },
      include: WITH_STATION,
    });
  }

  /** Every session of the gamer's the station may be unlocked for: what they are using now. */
  findGrantedByGamer(gamerProfileId: string) {
    return this.prisma.session.findMany({ where: { ...GRANTED, reservation: { gamerProfileId } }, include: WITH_STATION });
  }

  /** Sessions a station may currently be unlocked for. */
  findGrantedOnMachine(machineId: string) {
    return this.prisma.session.findMany({
      where: { ...GRANTED, reservation: { machineId } },
      include: WITH_STATION,
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * The gamer's bookings still ahead that no session has started on yet:
   * money they have promised but not yet used.
   */
  findUpcomingUnstarted(gamerProfileId: string, now: Date, excludeReservationId?: string) {
    return this.prisma.reservation.findMany({
      where: {
        gamerProfileId,
        status: 'CONFIRMED',
        endTime: { gt: now },
        sessions: { none: GRANTED },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
      },
      include: { machine: { select: { branchId: true } } },
    });
  }

  async userIdForGamer(gamerProfileId: string): Promise<string | null> {
    const profile = await this.prisma.gamerProfile.findUnique({ where: { id: gamerProfileId }, select: { userId: true } });
    return profile?.userId ?? null;
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

  /** Open sessions whose extension rate switch has come due. */
  findDueRateSwitches(now: Date) {
    return this.prisma.session.findMany({
      where: { status: { in: OPEN_SESSION_STATUSES }, rateSwitchAt: { lte: now } },
      include: WITH_STATION,
    });
  }

  /** Logged-into sessions ending within the notice window that haven't been told yet. */
  findEndingSoon(now: Date, until: Date) {
    return this.prisma.session.findMany({
      where: { ...GRANTED, endTime: { gt: now, lte: until }, endingNoticeSentAt: null },
      include: WITH_STATION,
    });
  }

  /**
   * CONFIRMED reservations with no login `graceMs` after their start ->
   * NO_SHOW, and their unused PINs are cancelled: the station is free again.
   */
  async markNoShows(now: Date, graceMs: number): Promise<number> {
    const where: Prisma.ReservationWhereInput = {
      status: 'CONFIRMED',
      startTime: { lte: new Date(now.getTime() - graceMs) },
      sessions: { none: { pinUsedAt: { not: null } } },
    };
    return this.prisma.$transaction(async (tx) => {
      const late = await tx.reservation.findMany({ where, select: { id: true } });
      if (late.length === 0) return 0;
      const ids = late.map((r) => r.id);
      await tx.session.updateMany({
        where: { reservationId: { in: ids }, status: 'PENDING', pinUsedAt: null },
        data: { status: 'CANCELLED', pinHash: null },
      });
      const { count } = await tx.reservation.updateMany({ where: { id: { in: ids }, status: 'CONFIRMED' }, data: { status: 'NO_SHOW' } });
      return count;
    });
  }

  /** The gamer's PAUSED session the backend locked for `lockReason`, still inside its window. */
  findPausedByGamer(gamerProfileId: string, lockReason: string, now: Date) {
    return this.prisma.session.findFirst({
      where: { status: 'PAUSED', lockReason, endTime: { gt: now }, reservation: { gamerProfileId } },
      include: WITH_STATION,
    });
  }

  /**
   * Moves a booking's end (and its session's) later, if nothing else holds
   * that time: another booking on the PC (`slot_taken`) or another booking of
   * the gamer's (`gamer_busy`). Serialized with booking creation on the same
   * advisory locks (machine first, then gamer).
   */
  async extendIfFree(input: {
    reservationId: string;
    sessionId: string;
    machineId: string;
    gamerProfileId: string;
    from: Date;
    to: Date;
    session: Prisma.SessionUpdateInput;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.machineId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gamer:${input.gamerProfileId}`}))`;

      const overlapping = {
        id: { not: input.reservationId },
        status: { in: [...HOLDING_RESERVATION_STATUSES] },
        startTime: { lt: input.to },
        endTime: { gt: input.from },
      } satisfies Prisma.ReservationWhereInput;
      if (await tx.reservation.findFirst({ where: { machineId: input.machineId, ...overlapping }, select: { id: true } })) {
        return { kind: 'slot_taken' as const };
      }
      if (await tx.reservation.findFirst({ where: { gamerProfileId: input.gamerProfileId, ...overlapping }, select: { id: true } })) {
        return { kind: 'gamer_busy' as const };
      }

      await tx.reservation.update({ where: { id: input.reservationId }, data: { endTime: input.to } });
      const session = await tx.session.update({ where: { id: input.sessionId }, data: { ...input.session, endTime: input.to } });
      return { kind: 'extended' as const, session };
    });
  }

  /** A retired PC's bookings still ahead are cancelled, with any PIN already issued for them. */
  async cancelFutureReservations(machineId: string, now: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const ahead = await tx.reservation.findMany({
        where: { machineId, status: { in: ['PENDING', 'CONFIRMED'] }, endTime: { gt: now } },
        select: { id: true },
      });
      if (ahead.length === 0) return 0;
      const ids = ahead.map((r) => r.id);
      await tx.session.updateMany({
        where: { reservationId: { in: ids }, status: 'PENDING', pinUsedAt: null },
        data: { status: 'CANCELLED', pinHash: null },
      });
      const { count } = await tx.reservation.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED' } });
      return count;
    });
  }

  /** Whether any booking holds the PC during [from, to), other than `exceptReservationId`. */
  async isMachineBusy(machineId: string, from: Date, to: Date, exceptReservationId: string): Promise<boolean> {
    const row = await this.prisma.reservation.findFirst({
      where: {
        machineId,
        id: { not: exceptReservationId },
        status: { in: [...HOLDING_RESERVATION_STATUSES] },
        startTime: { lt: to },
        endTime: { gt: from },
      },
      select: { id: true },
    });
    return row !== null;
  }
}

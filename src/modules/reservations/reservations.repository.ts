import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/repository/base.repository.js';
import type { Prisma } from '../../generated/prisma/index.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import type { CreateReservationDto } from './reservations.schemas.js';

@Injectable()
export class ReservationsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findGamerProfileId(userId: string) {
    return this.prisma.gamerProfile.findUnique({ where: { userId }, select: { id: true } });
  }

  listForGamer(gamerProfileId: string) {
    return this.prisma.reservation.findMany({
      where: { gamerProfileId },
      include: { machine: { select: { id: true, name: true, serialNumber: true, branchId: true } } },
      orderBy: { startTime: 'desc' },
    });
  }

  async createIfAvailable(gamerProfileId: string, input: CreateReservationDto, walkIn = false) {
    return this.prisma.$transaction(async (tx) => {
      // Serialize slot checks for this machine and this gamer; overlapping
      // requests cannot both win. Always machine first, then gamer: no deadlock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.machineId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gamer:${gamerProfileId}`}))`;

      // Play now needs the PC on now; a booking for later only needs it enrolled
      // (check-in checks it is online when the time comes).
      const machine = await tx.machine.findUnique({
        where: { id: input.machineId },
        select: { id: true, enrollmentStatus: true, status: true },
      });
      if (!machine || machine.enrollmentStatus !== 'ENROLLED' || (walkIn && machine.status !== 'ONLINE')) {
        return { kind: 'machine_unavailable' as const };
      }

      if (walkIn && input.startTime.getTime() > Date.now() + 60_000) {
        return { kind: 'invalid_walk_in' as const };
      }

      // ACTIVE = a session is running on this reservation (set by session-billing).
      const overlapping = {
        status: { in: ['PENDING', 'CONFIRMED', 'ACTIVE'] },
        startTime: { lt: input.endTime },
        endTime: { gt: input.startTime },
      } satisfies Prisma.ReservationWhereInput;
      const conflict = await tx.reservation.findFirst({ where: { machineId: input.machineId, ...overlapping }, select: { id: true } });
      if (conflict) return { kind: 'slot_taken' as const };

      // One gamer plays on one PC at a time: no holding several at once.
      const own = await tx.reservation.findFirst({ where: { gamerProfileId, ...overlapping }, select: { id: true } });
      if (own) return { kind: 'gamer_busy' as const };

      const reservation = await tx.reservation.create({
        data: {
          gamerProfileId,
          machineId: input.machineId,
          startTime: input.startTime,
          endTime: input.endTime,
          // Walk-ins are CONFIRMED like any booking: the gamer checks in on
          // it for their PIN, and session-billing alone moves it to ACTIVE
          // once the station reports the session running.
          status: 'CONFIRMED',
          isWalkIn: walkIn,
        },
        include: { machine: { select: { id: true, name: true, serialNumber: true, branchId: true } } },
      });
      return { kind: 'created' as const, reservation };
    });
  }

  async findOwned(id: string, gamerProfileId: string) {
    return this.prisma.reservation.findFirst({ where: { id, gamerProfileId } });
  }

  cancel(id: string) {
    return this.prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }
}

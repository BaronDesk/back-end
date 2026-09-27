import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

@Injectable()
export class BookingRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findAvailableMachines(branchId: string, start: Date, end: Date) {
    return this.prisma.machine.findMany({
      where: {
        branchId,
        enrollmentStatus: 'ENROLLED',
        reservations: {
          none: {
            status: { in: ['PENDING', 'CONFIRMED', 'ACTIVE'] },
            AND: [{ startTime: { lt: end } }, { endTime: { gt: start } }],
          },
        },
      },
    });
  }

  findOverlapping(machineId: string, start: Date, end: Date) {
    return this.prisma.reservation.findFirst({
      where: {
        machineId,
        status: { in: ['PENDING', 'CONFIRMED', 'ACTIVE'] },
        AND: [{ startTime: { lt: end } }, { endTime: { gt: start } }],
      },
    });
  }

  findGamerProfileByUserId(userId: string) {
    return this.prisma.gamerProfile.findUnique({ where: { userId } });
  }

  createReservation(gamerProfileId: string, machineId: string, start: Date, end: Date) {
    return this.prisma.reservation.create({
      data: {
        gamerProfileId,
        machineId,
        startTime: start,
        endTime: end,
        status: 'CONFIRMED',
      },
    });
  }

  findById(id: string) {
    return this.prisma.reservation.findUniqueOrThrow({
      where: { id },
      include: { gamerProfile: true },
    });
  }

  cancel(id: string) {
    return this.prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  }
}
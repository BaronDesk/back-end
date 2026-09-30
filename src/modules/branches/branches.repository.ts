import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../common/repository/base.repository.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

/** Reservations that hold their slot (ACTIVE = a session runs on it). */
const HOLDING = ['PENDING', 'CONFIRMED', 'ACTIVE'] as const;

@Injectable()
export class BranchesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list() {
    return this.prisma.branch.findMany({ orderBy: { name: 'asc' } });
  }

  findById(id: string) {
    return this.prisma.branch.findUnique({ where: { id } });
  }

  create(data: { name: string; location: string }) {
    return this.prisma.branch.create({ data });
  }

  update(id: string, data: { name?: string; location?: string }) {
    return this.prisma.branch.update({ where: { id }, data });
  }

  /** The branch's bookable stations, with the bookings that hold them from `from` to `until`. */
  stationsWithBookings(branchId: string, from: Date, until: Date) {
    return this.prisma.machine.findMany({
      where: { branchId, enrollmentStatus: 'ENROLLED' },
      select: {
        id: true,
        name: true,
        serialNumber: true,
        status: true,
        reservations: {
          where: { status: { in: [...HOLDING] }, endTime: { gt: from }, startTime: { lt: until } },
          select: { startTime: true, endTime: true },
          orderBy: { startTime: 'asc' },
        },
      },
      orderBy: [{ name: 'asc' }, { serialNumber: 'asc' }],
    });
  }
}

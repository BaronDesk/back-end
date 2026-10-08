import { Injectable, NotFoundException } from '@nestjs/common';

import { PresenceService } from '../station/services/presence.service.js';
import { BranchesRepository } from './branches.repository.js';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';

/** How far ahead the station list shows bookings (what a gamer can book is limited separately). */
const LOOKAHEAD_MS = 7 * 24 * 60 * 60_000;

const notFound = () => new NotFoundException({ code: 'BRANCH_NOT_FOUND', error: 'branch not found' });

export function toBranchDto(branch: { id: string; name: string; location: string }) {
  return { id: branch.id, name: branch.name, location: branch.location };
}

/**
 * Branches (gaming centres) and what a gamer needs to book at one: its
 * stations, whether each is online, and when it is taken.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly repo: BranchesRepository,
    private readonly presence: PresenceService,
    private readonly audit: AuditLogService,
  ) {}

  async list() {
    return (await this.repo.list()).map(toBranchDto);
  }

  async create(data: { name: string; location: string }) {
    return toBranchDto(await this.repo.create(data));
  }

  async update(caller: AccessTokenPayload, id: string, data: { name?: string; location?: string }) {
    if (!(await this.repo.findById(id))) throw notFound();
    const updated = await this.repo.update(id, data);
    await this.audit.record(caller.sub, 'UPDATE', `branch:${id}`, {
      branchId: id,
      metadata: { event: 'BRANCH_UPDATED', fields: Object.keys(data) },
    });
    return toBranchDto(updated);
  }

  /**
   * The branch's enrolled stations for the booking page: online now, free
   * now or busy until when, and the bookings ahead (start/end only — never
   * who booked).
   */
  async stations(branchId: string, now = new Date()) {
    if (!(await this.repo.findById(branchId))) throw notFound();
    const machines = await this.repo.stationsWithBookings(branchId, now, new Date(now.getTime() + LOOKAHEAD_MS));
    return machines.map((m) => {
      const current = m.reservations.find((r) => r.startTime <= now && r.endTime > now);
      return {
        id: m.id,
        name: m.name ?? m.serialNumber,
        serialNumber: m.serialNumber,
        online: this.presence.isOnline(m.serialNumber),
        busyNow: Boolean(current),
        busyUntil: current ? busyUntil(m.reservations, current.endTime).toISOString() : null,
        bookings: m.reservations.map((r) => ({ startTime: r.startTime.toISOString(), endTime: r.endTime.toISOString() })),
      };
    });
  }
}

/** The end of the current booking, following bookings that start right as it ends. */
function busyUntil(bookings: { startTime: Date; endTime: Date }[], end: Date): Date {
  let until = end;
  for (const b of bookings) {
    if (b.startTime <= until && b.endTime > until) until = b.endTime;
  }
  return until;
}

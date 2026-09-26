import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Redis } from 'ioredis';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
import type { Machine } from '../../../generated/prisma/index.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import { presenceCacheKey } from './presence.service.js';

type CachedPresence = Record<string, string>;

@Injectable()
export class StationsService {
  private readonly logger = new Logger(StationsService.name);

  constructor(
    private readonly machines: MachinesRepository,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async list(caller: AccessTokenPayload) {
    if (caller.scope !== 'hq' && !caller.branchId) return [];

    const machines = await this.machines.list(caller.scope === 'hq' ? null : caller.branchId);
    const cached = await this.readCache(machines.map((m) => m.serialNumber));
    return machines.map((m, i) => this.toStation(m, cached[i]));
  }

  async get(caller: AccessTokenPayload, id: string) {
    const machine = await this.machines.findById(id);
    if (!machine) throw new NotFoundException({ code: 'STATION_NOT_FOUND', error: 'station not found' });
    assertScope(caller, { branchId: machine.branchId });

    const [cached] = await this.readCache([machine.serialNumber]);
    return {
      ...this.toStation(machine, cached),
      branchId: machine.branchId,
      enrollmentStatus: machine.enrollmentStatus,
      leaseExpiresAt: cached?.leaseExpiresAt || null,
    };
  }

  /** Postgres is authoritative for status; Redis carries the fresher last_seen and agent-reported state. */
  private toStation(machine: Machine, cached: CachedPresence | undefined) {
    const cachedLastSeen = cached?.lastSeen ? new Date(cached.lastSeen) : null;
    const lastSeen =
      cachedLastSeen && (!machine.lastSeen || cachedLastSeen > machine.lastSeen) ? cachedLastSeen : machine.lastSeen;

    return {
      id: machine.id,
      serialNumber: machine.serialNumber,
      name: machine.name,
      status: machine.status,
      lastSeen: lastSeen?.toISOString() ?? null,
      locked: cached?.locked ? cached.locked === 'true' : null,
      sessionId: cached?.sessionId || null,
      // Set only once the agent reports it (state_report); never from a LAUNCH_GAME ack.
      runningGameId: cached?.runningGameId || null,
      ip: machine.ipAddress,
    };
  }

  private async readCache(serialNumbers: string[]): Promise<(CachedPresence | undefined)[]> {
    if (serialNumbers.length === 0) return [];
    try {
      const pipeline = this.redis.pipeline();
      for (const serial of serialNumbers) pipeline.hgetall(presenceCacheKey(serial));
      const results = (await pipeline.exec()) ?? [];
      return results.map(([err, value]) => (err ? undefined : (value as CachedPresence)));
    } catch (err) {
      this.logger.warn(`presence cache read failed: ${(err as Error).message}`);
      return serialNumbers.map(() => undefined);
    }
  }
}

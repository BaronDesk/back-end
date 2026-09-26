import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Subject } from 'rxjs';

import { REDIS } from '../../../infra/redis/redis.module.js';
import type { MachineStatus } from '../../../generated/prisma/index.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { HandshakePayload, HeartbeatPayload, StateReportPayload } from '../schemas/presence.schemas.js';

export function presenceCacheKey(serialNumber: string): string {
  return `node:${serialNumber}`;
}

export interface StationStatusEvent {
  serialNumber: string;
  name: string | null;
  status: MachineStatus;
  lastSeen: string;
  ip: string | null;
  locked: boolean | null;
  branchId: string;
}

/** What other modules may know about a station: identity and branch, nothing more. */
export interface StationRef {
  machineId: string;
  branchId: string;
  serialNumber: string;
}

interface PresenceState {
  machineId: string;
  branchId: string;
  serialNumber: string;
  name: string | null;
  status: MachineStatus;
  lastSeen: Date;
  ip: string | null;
  locked: boolean | null;
  sessionId: string | null;
  runningGameId: string | null;
  leaseExpiresAt: string | null;
  lastPersistedAt: number;
}

export class UnknownStationError extends Error {
  constructor(serialNumber: string) {
    super(`unknown station serial: ${serialNumber}`);
  }
}

/**
 * Owns station presence. The ops agent gateway drives it (connect / touch /
 * disconnect); it never writes MACHINE rows itself. Postgres is authoritative
 * for status, Redis `node:<serial>` is the fast-read mirror, and the in-memory
 * map is what the watchdog scans. ONLINE<->OFFLINE transitions are pushed on
 * `statusChanges` for ops to fan out to dashboards.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceService.name);
  private readonly states = new Map<string, PresenceState>();
  private watchdog?: NodeJS.Timeout;

  readonly statusChanges = new Subject<StationStatusEvent>();

  private readonly offlineAfterMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly persistIntervalMs: number;
  private readonly allowProvisional: boolean;

  constructor(
    private readonly machines: MachinesRepository,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.offlineAfterMs = Number(config.get('PRESENCE_OFFLINE_AFTER_MS') ?? 45_000);
    this.watchdogIntervalMs = Number(config.get('PRESENCE_WATCHDOG_INTERVAL_MS') ?? 10_000);
    this.persistIntervalMs = Number(config.get('PRESENCE_PERSIST_INTERVAL_MS') ?? 15_000);
    this.allowProvisional = config.get('NODE_ENV') !== 'production';
  }

  onModuleInit(): void {
    this.watchdog = setInterval(() => void this.sweep(), this.watchdogIntervalMs);
    this.watchdog.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.watchdog);
    this.statusChanges.complete();
  }

  /** handshake: resolve the machine by serial, mark it ONLINE. */
  async connect(handshake: HandshakePayload, ip: string | null): Promise<void> {
    const { serialNumber } = handshake;
    const name = handshake.machineName?.trim() || null;

    let machine = await this.machines.findBySerial(serialNumber);
    if (!machine) {
      if (!this.allowProvisional) throw new UnknownStationError(serialNumber);
      this.logger.warn(`unknown station ${serialNumber}: creating provisional MACHINE row (dev only)`);
      machine = await this.machines.createProvisional(serialNumber, name);
    }

    const now = new Date();
    const updated = await this.machines.markOnline(machine.id, { lastSeen: now, ipAddress: ip, name });
    const previous = this.states.get(serialNumber);

    const state: PresenceState = {
      machineId: updated.id,
      branchId: updated.branchId,
      serialNumber,
      name: updated.name,
      status: 'ONLINE',
      lastSeen: now,
      ip,
      locked: previous?.locked ?? null,
      sessionId: previous?.sessionId ?? null,
      runningGameId: previous?.runningGameId ?? null,
      leaseExpiresAt: previous?.leaseExpiresAt ?? null,
      lastPersistedAt: now.getTime(),
    };
    this.states.set(serialNumber, state);
    await this.writeCache(state);

    if (previous?.status !== 'ONLINE') this.emit(state);
  }

  /** heartbeat: bump last_seen; persist to Postgres at most every persist interval. */
  async touch(serialNumber: string, heartbeat: HeartbeatPayload): Promise<void> {
    const state = this.states.get(serialNumber);
    if (!state) return;

    const now = new Date();
    state.lastSeen = now;
    state.locked = heartbeat.locked;
    state.sessionId = heartbeat.sessionId ?? null;

    if (state.status !== 'ONLINE') {
      // Watchdog flipped it while the socket stayed open; heartbeats resumed.
      state.status = 'ONLINE';
      state.lastPersistedAt = now.getTime();
      await this.machines.setStatus(state.machineId, 'ONLINE', now);
      this.emit(state);
    } else if (now.getTime() - state.lastPersistedAt >= this.persistIntervalMs) {
      state.lastPersistedAt = now.getTime();
      await this.machines.touchLastSeen(state.machineId, now);
    }

    await this.writeCache(state);
  }

  /** state_report: cache-only update of what the agent says it is doing. */
  async reportState(serialNumber: string, report: StateReportPayload): Promise<void> {
    const state = this.states.get(serialNumber);
    if (!state) return;

    if (report.locked !== undefined) state.locked = report.locked;
    if (report.sessionId !== undefined) state.sessionId = report.sessionId ?? null;
    if (report.runningGameId !== undefined) state.runningGameId = report.runningGameId ?? null;
    if (report.leaseExpiresAt !== undefined) state.leaseExpiresAt = report.leaseExpiresAt ?? null;
    await this.writeCache(state);
  }

  /** socket close/error. */
  async disconnect(serialNumber: string): Promise<void> {
    await this.markOffline(serialNumber, 'socket closed');
  }

  /** Resolves a connected (or recently seen) station by serial, from memory. */
  resolve(serialNumber: string): StationRef | null {
    const state = this.states.get(serialNumber);
    return state ? toRef(state) : null;
  }

  /** Resolves any station by MACHINE id; falls back to Postgres when not in memory. */
  async resolveById(machineId: string): Promise<StationRef | null> {
    for (const state of this.states.values()) {
      if (state.machineId === machineId) return toRef(state);
    }
    const machine = await this.machines.findById(machineId);
    return machine
      ? { machineId: machine.id, branchId: machine.branchId, serialNumber: machine.serialNumber }
      : null;
  }

  onlineStations(): StationRef[] {
    return [...this.states.values()].filter((s) => s.status === 'ONLINE').map(toRef);
  }

  /** Watchdog: catches crash / power loss, where no close frame ever arrives. */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.offlineAfterMs;

    try {
      for (const state of this.states.values()) {
        if (state.status === 'ONLINE' && state.lastSeen.getTime() < cutoff) {
          await this.markOffline(state.serialNumber, 'heartbeat timeout');
        }
      }

      // Rows left ONLINE by a previous process (server crash/restart) that no
      // live connection has claimed.
      const stale = await this.machines.findStaleOnline(new Date(cutoff));
      for (const machine of stale) {
        if (this.states.get(machine.serialNumber)?.status === 'ONLINE') continue;

        const lastSeen = machine.lastSeen ?? new Date();
        await this.machines.setStatus(machine.id, 'OFFLINE', lastSeen);
        const state: PresenceState = {
          machineId: machine.id,
          branchId: machine.branchId,
          serialNumber: machine.serialNumber,
          name: machine.name,
          status: 'OFFLINE',
          lastSeen,
          ip: machine.ipAddress,
          locked: null,
          sessionId: null,
          runningGameId: null,
          leaseExpiresAt: null,
          lastPersistedAt: Date.now(),
        };
        this.states.set(machine.serialNumber, state);
        await this.writeCache(state);
        this.logger.log(`station ${machine.serialNumber} OFFLINE (stale row from previous run)`);
        this.emit(state);
      }
    } catch (err) {
      this.logger.error(`presence watchdog sweep failed: ${(err as Error).message}`);
    }
  }

  private async markOffline(serialNumber: string, reason: string): Promise<void> {
    const state = this.states.get(serialNumber);
    if (!state || state.status === 'OFFLINE') return;

    state.status = 'OFFLINE';
    state.lastPersistedAt = Date.now();
    await this.machines.setStatus(state.machineId, 'OFFLINE', state.lastSeen);
    await this.writeCache(state);
    this.logger.log(`station ${serialNumber} OFFLINE (${reason})`);
    this.emit(state);
  }

  private emit(state: PresenceState): void {
    this.statusChanges.next({
      serialNumber: state.serialNumber,
      name: state.name,
      status: state.status,
      lastSeen: state.lastSeen.toISOString(),
      ip: state.ip,
      locked: state.locked,
      branchId: state.branchId,
    });
  }

  /** Redis is a cache: a failure is logged, never allowed to break the agent flow. */
  private async writeCache(state: PresenceState): Promise<void> {
    try {
      await this.redis.hset(presenceCacheKey(state.serialNumber), {
        status: state.status,
        lastSeen: state.lastSeen.toISOString(),
        ip: state.ip ?? '',
        locked: state.locked === null ? '' : String(state.locked),
        sessionId: state.sessionId ?? '',
        leaseExpiresAt: state.leaseExpiresAt ?? '',
      });
    } catch (err) {
      this.logger.warn(`presence cache write failed for ${state.serialNumber}: ${(err as Error).message}`);
    }
  }
}

function toRef(state: PresenceState): StationRef {
  return { machineId: state.machineId, branchId: state.branchId, serialNumber: state.serialNumber };
}

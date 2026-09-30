import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Subject } from 'rxjs';

import { REDIS } from '../../../infra/redis/redis.module.js';
import type { Machine, MachineStatus, Prisma } from '../../../generated/prisma/index.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { HandshakePayload, HeartbeatPayload, Peripheral, StateReportPayload } from '../schemas/presence.schemas.js';
import type { StationPrincipal } from './station-token.service.js';

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
  sessionId: string | null;
  runningGameId: string | null;
  branchId: string;
}

/**
 * `session.ended`: a station the agent reported with a session now reports
 * none. Device-level only; billing close-out (Member B) subscribes to
 * `PresenceService.sessionEnded`. `reason` is the END_SESSION reason when the
 * end followed one, else `agent_reported`.
 */
export interface SessionEndedEvent {
  machineId: string;
  branchId: string;
  serialNumber: string;
  sessionId: string;
  reason: string;
  endedAt: string;
}

/** An END_SESSION reason is matched to the observed session end only within this window. */
const SESSION_END_MATCH_MS = 2 * 60_000;

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
  /** When the station was last heard from before this connection (null: never, or unknown). */
  lastSeenBeforeConnect: Date | null;
}

/** The station token's machine has no MACHINE row. */
export class UnknownStationError extends Error {
  constructor(machineId: string) {
    super(`no MACHINE row for station ${machineId}`);
  }
}

/** The MACHINE row exists but its enrollmentStatus is not ENROLLED. */
export class StationNotEnrolledError extends Error {
  constructor(machineId: string, status: string) {
    super(`station ${machineId} is not enrolled (${status})`);
  }
}

/** The station token's serial / branch no longer match its MACHINE row. */
export class StationIdentityMismatchError extends Error {
  constructor(machineId: string) {
    super(`station token for ${machineId} does not match its MACHINE row`);
  }
}

/**
 * The one admission rule for a verified station token: its MACHINE row must
 * exist, be ENROLLED, and still carry the token's serial and branch.
 */
export function assertStationAdmitted(
  machine: Machine | null,
  principal: StationPrincipal,
): asserts machine is Machine {
  if (!machine) throw new UnknownStationError(principal.machineId);
  if (machine.enrollmentStatus !== 'ENROLLED') {
    throw new StationNotEnrolledError(principal.machineId, machine.enrollmentStatus);
  }
  if (machine.serialNumber !== principal.serialNumber || machine.branchId !== principal.branchId) {
    throw new StationIdentityMismatchError(principal.machineId);
  }
  // A rotated (or re-enrolled) credential bumps the version: the old token is dead.
  if (machine.credentialVersion !== principal.version) {
    throw new StationIdentityMismatchError(principal.machineId);
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
  /** serial -> END_SESSION reason awaiting the agent's report that the session is gone. */
  private readonly pendingSessionEnds = new Map<string, { reason: string; at: number }>();
  private watchdog?: NodeJS.Timeout;

  /**
   * Pushed on ONLINE<->OFFLINE and whenever the agent reports a change of
   * locked / sessionId / runningGameId.
   */
  readonly statusChanges = new Subject<StationStatusEvent>();
  readonly sessionEnded = new Subject<SessionEndedEvent>();

  private readonly offlineAfterMs: number;
  private readonly watchdogIntervalMs: number;
  private readonly persistIntervalMs: number;

  constructor(
    private readonly machines: MachinesRepository,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.offlineAfterMs = Number(config.get('PRESENCE_OFFLINE_AFTER_MS') ?? 45_000);
    this.watchdogIntervalMs = Number(config.get('PRESENCE_WATCHDOG_INTERVAL_MS') ?? 10_000);
    this.persistIntervalMs = Number(config.get('PRESENCE_PERSIST_INTERVAL_MS') ?? 15_000);
  }

  onModuleInit(): void {
    this.watchdog = setInterval(() => void this.sweep(), this.watchdogIntervalMs);
    this.watchdog.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.watchdog);
    this.statusChanges.complete();
    this.sessionEnded.complete();
  }

  /**
   * handshake: the machine is the verified token's machineId, never the
   * handshake serial. Admission is re-checked here (enrollment may have
   * changed since the upgrade); an unknown station is rejected, never created.
   */
  async connect(handshake: HandshakePayload, ip: string | null, principal: StationPrincipal): Promise<void> {
    const { serialNumber } = handshake;
    const name = handshake.machineName?.trim() || null;

    const machine = await this.machines.findById(principal.machineId);
    assertStationAdmitted(machine, principal);

    const now = new Date();
    const previous = this.states.get(serialNumber);
    const lastSeenBeforeConnect = previous?.lastSeen ?? machine.lastSeen ?? null;
    // The station's own name only fills in a missing one: a staff rename sticks.
    const updated = await this.machines.markOnline(machine.id, { lastSeen: now, ipAddress: ip, name: machine.name ? null : name });

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
      lastSeenBeforeConnect,
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
    const changed = this.applyReport(state, { locked: heartbeat.locked, sessionId: heartbeat.sessionId ?? null });

    if (state.status !== 'ONLINE') {
      // Watchdog flipped it while the socket stayed open; heartbeats resumed.
      state.status = 'ONLINE';
      state.lastPersistedAt = now.getTime();
      await this.machines.setStatus(state.machineId, 'ONLINE', now);
      this.emit(state);
    } else if (now.getTime() - state.lastPersistedAt >= this.persistIntervalMs) {
      state.lastPersistedAt = now.getTime();
      await this.machines.touchLastSeen(state.machineId, now);
      if (changed) this.emit(state);
    } else if (changed) {
      this.emit(state);
    }

    await this.writeCache(state);
  }

  /** state_report: cache-only update of what the agent says it is doing. */
  async reportState(serialNumber: string, report: StateReportPayload): Promise<void> {
    const state = this.states.get(serialNumber);
    if (!state) return;

    // runningGameId is only ever set from here: a LAUNCH_GAME ack means
    // "accepted", not "running" (the agent's launch is still a stub).
    const changed = this.applyReport(state, {
      locked: report.locked,
      sessionId: report.sessionId === undefined ? undefined : (report.sessionId ?? null),
      runningGameId: report.runningGameId === undefined ? undefined : (report.runningGameId ?? null),
    });
    if (report.leaseExpiresAt !== undefined) state.leaseExpiresAt = report.leaseExpiresAt ?? null;
    if (changed && state.status === 'ONLINE') this.emit(state);
    await this.writeCache(state);
  }

  /** When the station was last heard from before its current connection (for closing out what it dropped meanwhile). */
  lastSeenBeforeConnect(serialNumber: string): Date | null {
    return this.states.get(serialNumber)?.lastSeenBeforeConnect ?? null;
  }

  /**
   * peripheral_status / state_report.peripherals: stores the full snapshot on
   * the machine. Returns what to push to dashboards, or null for an unknown station.
   */
  async reportPeripherals(serialNumber: string, peripherals: Peripheral[]) {
    const state = this.states.get(serialNumber);
    if (!state) return null;
    const reportedAt = new Date();
    await this.machines.setPeripherals(state.machineId, peripherals as unknown as Prisma.InputJsonValue, reportedAt);
    return { machineId: state.machineId, serialNumber, branchId: state.branchId, reportedAt: reportedAt.toISOString(), peripherals };
  }

  /** A staff rename: the live state (and dashboards) show it at once. */
  renamed(machineId: string, name: string): void {
    for (const state of this.states.values()) {
      if (state.machineId !== machineId) continue;
      state.name = name;
      this.emit(state);
    }
  }

  /** The agent's last reported session for a station, or null. */
  sessionOf(serialNumber: string): string | null {
    return this.states.get(serialNumber)?.sessionId ?? null;
  }

  /** The agent's last reported lock / session / game, or null for a station never seen. */
  agentStateOf(serialNumber: string): { locked: boolean | null; sessionId: string | null; runningGameId: string | null } | null {
    const state = this.states.get(serialNumber);
    return state ? { locked: state.locked, sessionId: state.sessionId, runningGameId: state.runningGameId } : null;
  }

  /**
   * END_SESSION was issued: label the next observed session end with its
   * reason. Nothing changes here; the end itself is only taken from the
   * agent's heartbeat / state_report.
   */
  expectSessionEnd(serialNumber: string, reason: string): void {
    this.pendingSessionEnds.set(serialNumber, { reason, at: Date.now() });
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

  isOnline(serialNumber: string): boolean {
    return this.states.get(serialNumber)?.status === 'ONLINE';
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
          lastSeenBeforeConnect: null,
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

  /**
   * Applies agent-reported fields (undefined = not reported) and returns
   * whether any of them changed. Emits `session.ended` on a session -> none
   * transition.
   */
  private applyReport(
    state: PresenceState,
    report: { locked?: boolean; sessionId?: string | null; runningGameId?: string | null },
  ): boolean {
    let changed = false;
    if (report.locked !== undefined && report.locked !== state.locked) {
      state.locked = report.locked;
      changed = true;
    }
    if (report.runningGameId !== undefined && report.runningGameId !== state.runningGameId) {
      state.runningGameId = report.runningGameId;
      changed = true;
    }
    if (report.sessionId !== undefined && report.sessionId !== state.sessionId) {
      const previous = state.sessionId;
      state.sessionId = report.sessionId;
      changed = true;
      if (previous && !report.sessionId) this.endSession(state, previous);
    }
    return changed;
  }

  private endSession(state: PresenceState, sessionId: string): void {
    const pending = this.pendingSessionEnds.get(state.serialNumber);
    this.pendingSessionEnds.delete(state.serialNumber);
    const matched = pending && Date.now() - pending.at <= SESSION_END_MATCH_MS ? pending : null;
    const reason = matched?.reason ?? 'agent_reported';
    // The agent stops its tracked game as part of END_SESSION, and only
    // re-sends runningGameId on its next reconnect (state_report). Clear it
    // here so the station does not keep showing a game it already closed.
    if (matched) state.runningGameId = null;
    this.logger.log(`session ${sessionId} ended on ${state.serialNumber} (${reason})`);
    this.sessionEnded.next({
      machineId: state.machineId,
      branchId: state.branchId,
      serialNumber: state.serialNumber,
      sessionId,
      reason,
      endedAt: new Date().toISOString(),
    });
  }

  private emit(state: PresenceState): void {
    this.statusChanges.next({
      serialNumber: state.serialNumber,
      name: state.name,
      status: state.status,
      lastSeen: state.lastSeen.toISOString(),
      ip: state.ip,
      locked: state.locked,
      sessionId: state.sessionId,
      runningGameId: state.runningGameId,
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
        runningGameId: state.runningGameId ?? '',
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

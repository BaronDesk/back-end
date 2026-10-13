import { ConflictException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import type { StateReportPayload } from '../../station/schemas/presence.schemas.js';
import {
  PresenceService,
  type SessionEndedEvent,
  type StationRef,
  type StationStatusEvent,
} from '../../station/services/presence.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { rateAt, type Meter } from '../util/metering.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';
import {
  insufficientFunds,
  isGranted,
  leaseFor,
  notFound,
  OFFLINE_LOCK,
  RUNOUT_LOCK,
  sessionConfig,
} from '../util/session-rules.js';

import { RunoutTimerService } from './runout-timer.service.js';
import { SessionMeteringService } from './session-metering.service.js';
import { SessionRunoutService } from './session-runout.service.js';

/**
 * What the station reports drives a session: ACTIVE/PAUSED from presence's
 * agent-reported lock state (the same path whether a station got locked by
 * staff, by a lapsed lease, by running out of funds or by going offline,
 * never by a command ack), COMPLETED once the station ends it. Also the
 * reconnect reconcile, and the staff controls that reach the station.
 */
@Injectable()
export class StationLinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StationLinkService.name);
  private readonly subs: Subscription[] = [];
  private readonly leaseCapSeconds: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    private readonly metering: SessionMeteringService,
    private readonly runout: SessionRunoutService,
    config: ConfigService,
  ) {
    this.leaseCapSeconds = sessionConfig(config).leaseCapSeconds;
  }

  onModuleInit(): void {
    this.subs.push(
      this.presence.statusChanges.subscribe((event) => void this.onStationStatus(event)),
      this.presence.sessionEnded.subscribe((event) => void this.onSessionEnded(event)),
    );
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
  }

  // --- staff ---------------------------------------------------------------

  /** Staff-forced end; the actual billing close-out only runs once presence confirms the station cleared the session (onSessionEnded). */
  async end(caller: AccessTokenPayload, id: string, reason?: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    if (!OPEN_SESSION_STATUSES.includes(session.status)) {
      throw new ConflictException({ code: 'SESSION_NOT_OPEN', error: 'session is already closed' });
    }
    return this.commands.issue(caller, session.reservation.machineId, { type: 'END_SESSION', reason });
  }

  /**
   * Staff close-out that does not wait for the station. Asks the station to
   * end the session (skipped if offline or it runs another one), then closes
   * at once from server state:
   * - ACTIVE/PAUSED (it played): settled, metered up to now -> COMPLETED.
   * - PENDING (never played): no metering, no debit -> CANCELLED / NO_SHOW.
   * A later presence sessionEnded finds the session closed and does nothing;
   * the debit key is shared, so it never bills twice.
   */
  async forceClose(caller: AccessTokenPayload, id: string, reason?: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    if (!OPEN_SESSION_STATUSES.includes(session.status)) {
      throw new ConflictException({ code: 'SESSION_NOT_OPEN', error: 'session is already closed' });
    }
    try {
      await this.commands.issueSystemEndSession(session.reservation.machineId, reason ?? 'force_close', id);
    } catch (err) {
      // The station may be gone for good; settlement must not depend on it.
      this.logger.warn(`force-close END_SESSION for session ${id} failed: ${(err as Error).message}`);
    }
    // One retry covers a PENDING session that a login activated between the read and the close.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.repo.findForSettlement(id);
      if (!current || !OPEN_SESSION_STATUSES.includes(current.status)) break;
      const closed =
        current.status === 'PENDING' && !current.pinUsedAt
          ? await this.repo.closeAsNoShow(current.id, current.reservationId, { unusedPinOnly: true })
          : await this.metering.settle(current, new Date(), reason ?? 'force_close');
      if (closed) break;
    }
    await this.runoutTimer.cancel(id);
    const closed = await this.repo.findByIdWithReservation(id);
    return toSessionDto((closed ?? session) as SessionRecord);
  }

  /** A staff UNLOCK resumes the station's own open session; there is no unlocking without one. */
  async unlockFor(station: StationRef) {
    const now = new Date();
    const reported = this.presence.sessionOf(station.serialNumber);
    const sessions = (await this.repo.findGrantedOnMachine(station.machineId)).filter((s) => isGranted(s, now));
    const session = sessions.find((s) => s.id === reported) ?? sessions[sessions.length - 1];
    if (!session) {
      throw new ConflictException({
        code: 'NO_SESSION_TO_UNLOCK',
        error: 'this PC has no session to unlock: the gamer checks in with their PIN',
      });
    }
    if (
      session.lockReason === RUNOUT_LOCK &&
      !(await this.metering.coversMinimumPlay(session.reservation.gamerProfileId, rateAt(session as Meter, now)))
    ) {
      throw insufficientFunds('the gamer ran out of money: top up their wallet first');
    }
    return { sessionId: session.id, ...leaseFor(session, now, this.leaseCapSeconds) };
  }

  /** Before a SHUTDOWN: the gamer stops playing now, so they pay until now. */
  async closeForShutdown(station: StationRef): Promise<void> {
    const now = new Date();
    for (const session of await this.repo.findGrantedOnMachine(station.machineId)) {
      await this.metering.settle(session, now, 'shutdown');
    }
  }

  /**
   * A revoked or rejected PC: whatever runs on it is settled now, and its
   * bookings still ahead are cancelled (they can't be played there).
   */
  async retireMachine(machineId: string): Promise<void> {
    const now = new Date();
    for (const session of await this.repo.findGrantedOnMachine(machineId)) {
      await this.metering.settle(session, now, 'station_revoked');
    }
    const cancelled = await this.repo.cancelFutureReservations(machineId, now);
    if (cancelled) this.logger.warn(`station ${machineId} retired: ${cancelled} booking(s) cancelled`);
  }

  // --- station -------------------------------------------------------------

  /**
   * state_report on (re)connect. A session still open and in its window is
   * resumed with a fresh UNLOCK + lease; metering picks up again once presence
   * sees locked=false. A session that ran past its window meanwhile is settled
   * and ended on the station; any other session the station holds is ended.
   * A station that reports no session has dropped the ones we still think it
   * runs (it ended them while it, or we, were away): they are settled at the
   * last moment the station was known to be in use.
   */
  async reconcile(station: StationRef, report: StateReportPayload): Promise<void> {
    const now = new Date();
    if (!report.sessionId) {
      const lastSeen = this.presence.lastSeenBeforeConnect(station.serialNumber);
      for (const session of await this.repo.findGrantedOnMachine(station.machineId)) {
        const endedAt = session.lockedAt ?? lastSeen ?? now;
        this.logger.warn(`station ${station.serialNumber} no longer holds session ${session.id}; settling it at ${endedAt.toISOString()}`);
        await this.metering.settle(session, endedAt, 'station_dropped');
      }
      return;
    }

    const found = await this.repo.findForSettlement(report.sessionId);
    const session = found?.reservation.machineId === station.machineId ? found : null;

    if (session && isGranted(session, now)) {
      await this.commands.issueSessionUnlock(
        station.machineId,
        { sessionId: session.id, ...leaseFor(session, now, this.leaseCapSeconds) },
        'resume',
      );
      return;
    }
    if (session && OPEN_SESSION_STATUSES.includes(session.status) && session.endTime <= now) {
      await this.metering.closeOverdue(session);
      return;
    }
    this.logger.warn(`station ${station.serialNumber} reports session ${report.sessionId}, which is not open for it; ending it`);
    await this.commands.issueSystemEndSession(station.machineId, 'session_closed', report.sessionId);
  }

  private async onStationStatus(event: StationStatusEvent): Promise<void> {
    try {
      if (event.status === 'OFFLINE') {
        await this.pauseForOffline(event);
        return;
      }
      if (!event.sessionId) return;
      const found = await this.repo.findForSettlement(event.sessionId);
      if (!found || !OPEN_SESSION_STATUSES.includes(found.status)) return;
      const session = await this.metering.foldRateSwitch(found, new Date());

      if (event.locked === false && session.status !== 'ACTIVE') {
        // The agent binds a session only from an UNLOCK, which only follows an accepted login.
        if (session.status === 'PENDING' && !session.pinUsedAt) return;
        const now = new Date();
        await this.repo.activate(session.id, session.reservationId, {
          status: 'ACTIVE',
          meteringStartedAt: now,
          lockedAt: null,
          lockReason: null,
        });
        await this.runout.scheduleRunout({ ...session, status: 'ACTIVE', meteringStartedAt: now, lockedAt: null, lockReason: null });
      } else if (event.locked === true && session.status === 'ACTIVE') {
        await this.metering.pause(session, new Date(), session.lockReason);
      }
    } catch (err) {
      this.logger.error(`station status handling failed for ${event.serialNumber}: ${(err as Error).message}`);
    }
  }

  /** The station went away: it locks itself when its lease runs out, so stop billing at its last heartbeat. */
  private async pauseForOffline(event: StationStatusEvent): Promise<void> {
    const station = this.presence.resolve(event.serialNumber);
    if (!station) return;
    const lastSeen = new Date(event.lastSeen);
    for (const found of await this.repo.findGrantedOnMachine(station.machineId)) {
      if (found.status !== 'ACTIVE') continue;
      const session = await this.metering.foldRateSwitch(found, lastSeen);
      await this.metering.pause(session, lastSeen, OFFLINE_LOCK);
      this.logger.log(`session ${session.id} paused: station ${event.serialNumber} offline since ${event.lastSeen}`);
    }
  }

  private async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    const session = await this.repo.findForSettlement(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.metering.settle(session, new Date(event.endedAt), event.reason);
  }
}

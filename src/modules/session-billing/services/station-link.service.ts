import { ConflictException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { JobsOptions, Queue } from 'bullmq';
import type { Subscription } from 'rxjs';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { DashboardGateway } from '../../ops/dashboard.gateway.js';
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
  isHeldLock,
  leaseFor,
  notFound,
  OFFLINE_LOCK,
  resumesOnReconnect,
  RUNOUT_LOCK,
  sessionConfig,
  STAFF_LOCK,
  type SettlementSession,
} from '../util/session-rules.js';

import {
  settleJobId,
  STATION_EVENT_JOBS,
  STATION_EVENTS_QUEUE,
  statusJobId,
  type StationEventJobData,
} from '../schemas/station-events.schemas.js';

import { RunoutTimerService } from './runout-timer.service.js';
import { SessionMeteringService } from './session-metering.service.js';
import { SessionRunoutService } from './session-runout.service.js';

/**
 * What the station reports drives a session: ACTIVE/PAUSED from presence's
 * agent-reported lock state (the same path whether a station got locked by
 * staff, by a lapsed lease, by running out of funds or by going offline,
 * never by a command ack), COMPLETED once the station ends it. Also the
 * reconnect reconcile, and the staff controls that reach the station (or are
 * applied from server state when they cannot).
 *
 * Why a session is locked decides what lifts it: "offline" is lifted by the
 * station reconnecting, "staff" only by a staff UNLOCK, "runout" only by a
 * top-up (or a staff UNLOCK once the wallet covers the minimum play time).
 */
@Injectable()
export class StationLinkService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StationLinkService.name);
  private readonly subs: Subscription[] = [];
  private readonly leaseCapSeconds: number;
  /** The most play billed after a single drop: the lease the station held, plus grace. */
  private readonly offlineBillCapSeconds: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    private readonly metering: SessionMeteringService,
    private readonly runout: SessionRunoutService,
    private readonly dashboard: DashboardGateway,
    @InjectQueue(STATION_EVENTS_QUEUE) private readonly events: Queue<StationEventJobData>,
    config: ConfigService,
  ) {
    const settings = sessionConfig(config);
    this.leaseCapSeconds = settings.leaseCapSeconds;
    this.offlineBillCapSeconds = settings.leaseCapSeconds + settings.stationLeaseGraceS;
  }

  /**
   * Presence events only enqueue their billing follow-up (Redis, deterministic
   * job id); StationEventsProcessor runs it. A crash between the event and its
   * handling no longer loses it: the job runs when a worker is back.
   */
  onModuleInit(): void {
    this.subs.push(
      this.presence.statusChanges.subscribe((event) => void this.enqueueStationStatus(event, new Date())),
      this.presence.sessionEnded.subscribe((event) => void this.enqueueSessionEnded(event)),
    );
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
  }

  /** Queues the settlement of a session the station ended (once per session while it waits). */
  async enqueueSessionEnded(event: SessionEndedEvent): Promise<void> {
    await this.enqueue(STATION_EVENT_JOBS.SETTLE, { event }, settleJobId(event.sessionId), () => this.handleSessionEnded(event));
  }

  /** Queues a lock-state / online change, stamped with when it was seen. */
  async enqueueStationStatus(event: StationStatusEvent, at: Date): Promise<void> {
    await this.enqueue(STATION_EVENT_JOBS.STATUS, { event, at: at.toISOString() }, statusJobId(event, at), () =>
      this.handleStationStatus(event, at),
    );
  }

  /** Never throws. With Redis unreachable the follow-up runs here and now, as before the queue. */
  private async enqueue(name: string, data: StationEventJobData, jobId: string, inline: () => Promise<void>): Promise<void> {
    try {
      await this.events.add(name, data, STATION_EVENT_JOB_OPTIONS(jobId));
    } catch (err) {
      this.logger.error(`could not queue ${jobId} (${(err as Error).message}): handling it in-process`);
      try {
        await inline();
      } catch (inlineErr) {
        this.logger.error(`${jobId} failed: ${(inlineErr as Error).message}`);
      }
    }
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
    await this.closeFromServerState(id, new Date(), reason ?? 'force_close');
    const closed = await this.repo.findByIdWithReservation(id);
    return toSessionDto((closed ?? session) as SessionRecord);
  }

  /**
   * Closes a session without the station: settled up to `endedAt` if it
   * played, a no-show if nobody logged into it. Shared debit key: a later
   * session end from the station never bills it twice.
   */
  private async closeFromServerState(id: string, endedAt: Date, reason: string): Promise<void> {
    // One retry covers a PENDING session that a login activated between the read and the close.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.repo.findForSettlement(id);
      if (!current || !OPEN_SESSION_STATUSES.includes(current.status)) break;
      const closed =
        current.status === 'PENDING' && !current.pinUsedAt
          ? await this.repo.closeAsNoShow(current.id, current.reservationId, { unusedPinOnly: true })
          : await this.metering.settle(current, endedAt, reason);
      if (closed) break;
    }
    await this.runoutTimer.cancel(id);
  }

  /** A staff LOCK on its way: the open session is locked by staff, so a reconnect never lifts it. */
  async markStaffLock(station: StationRef): Promise<void> {
    for (const session of await this.repo.findGrantedOnMachine(station.machineId)) {
      await this.repo.update(session.id, { lockReason: STAFF_LOCK });
    }
  }

  /**
   * A staff LOCK the station could not receive (offline, or no ack): the
   * intent is kept. A session still ACTIVE stops metering at the last
   * contact; either way it is locked by staff, and the reconnect keeps it
   * locked. False when the station has no open session.
   */
  async lockWhileOffline(station: StationRef): Promise<boolean> {
    const sessions = await this.repo.findGrantedOnMachine(station.machineId);
    const lastContact = this.presence.lastContactOf(station.serialNumber) ?? new Date();
    for (const found of sessions) {
      if (found.status === 'ACTIVE') {
        const session = await this.metering.foldRateSwitch(found, lastContact);
        await this.metering.pause(session, lastContact, STAFF_LOCK);
      } else {
        await this.repo.update(found.id, { lockReason: STAFF_LOCK });
      }
      this.logger.log(`session ${found.id} locked by staff while station ${station.serialNumber} is unreachable`);
    }
    return sessions.length > 0;
  }

  /**
   * A staff END_SESSION the station could not receive: closed from server
   * state as a force-close, billed up to the last contact. The reconnect ends
   * it on the station (reconcile). False when the station has no open session.
   */
  async endWhileOffline(station: StationRef, reason: string): Promise<boolean> {
    const sessions = await this.repo.findGrantedOnMachine(station.machineId);
    const lastContact = this.presence.lastContactOf(station.serialNumber) ?? new Date();
    for (const session of sessions) {
      await this.closeFromServerState(session.id, lastContact, reason);
      this.logger.log(`session ${session.id} ended by staff while station ${station.serialNumber} is unreachable`);
    }
    return sessions.length > 0;
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
    // Staff lifts whatever lock it held: the station reporting itself unlocked now resumes metering.
    if (session.lockReason) await this.repo.update(session.id, { lockReason: null });
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
   * At the handshake, before the station reports anything: a session still
   * ACTIVE although the station was unreachable past the offline timeout was
   * never paused (the backend restarted and the station reconnected before
   * the watchdog marked its stale row OFFLINE). It is paused at the last
   * contact, as the OFFLINE handling would have: the time the station could
   * not reach us is not billed, and reconcile then resumes it.
   */
  async reconnected(station: StationRef): Promise<void> {
    const lastContact = this.presence.unreachableSince(station.serialNumber);
    if (!lastContact) return;
    for (const found of await this.repo.findGrantedOnMachine(station.machineId)) {
      if (found.status !== 'ACTIVE') continue;
      const session = await this.metering.foldRateSwitch(found, lastContact);
      await this.metering.pause(session, lastContact, isHeldLock(session.lockReason) ? session.lockReason : OFFLINE_LOCK);
      this.logger.warn(`session ${session.id} paused at ${lastContact.toISOString()}: station ${station.serialNumber} was unreachable but never marked offline`);
    }
  }

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
      for (const found of await this.repo.findGrantedOnMachine(station.machineId)) {
        const session = await this.billSingleDrop(station, found, report);
        const endedAt = session.lockedAt ?? lastSeen ?? now;
        this.logger.warn(`station ${station.serialNumber} no longer holds session ${session.id}; settling it at ${endedAt.toISOString()}`);
        this.flagAttention(station, session, report, now);
        await this.metering.settle(session, endedAt, 'station_dropped');
      }
      return;
    }

    const found = await this.repo.findForSettlement(report.sessionId);
    const session = found?.reservation.machineId === station.machineId ? found : null;

    if (session && isGranted(session, now)) {
      this.flagAttention(station, session, report, now);
      if (!resumesOnReconnect(session)) {
        // Locked by staff, for funds, or for no recorded reason: a reconnect never lifts that.
        this.logger.log(`station ${station.serialNumber} reconnected; session ${session.id} stays locked (${session.lockReason ?? 'no reason'})`);
        if (report.locked === false) await this.commands.issueSystemLock(station.machineId, session.lockReason ?? 'locked');
        return;
      }
      const resumed = await this.billSingleDrop(station, session, report);
      await this.commands.issueSessionUnlock(
        station.machineId,
        { sessionId: resumed.id, ...leaseFor(resumed, now, this.leaseCapSeconds) },
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

  /**
   * A session paused offline whose station dropped on its own (not with its
   * venue) and says when it locked itself: the gamer played on until then, so
   * that time is billed (capped by the lease, once). A venue outage, an
   * unknown drop, a restart or a lock at startup bills nothing past the last
   * contact.
   */
  private async billSingleDrop(station: StationRef, session: SettlementSession, report: StateReportPayload): Promise<SettlementSession> {
    if (session.status !== 'PAUSED' || session.lockReason !== OFFLINE_LOCK || !report.lockedAt) return session;
    if (report.restarted || report.lockReason === 'startup') return session;
    if (this.presence.outageOf(station.serialNumber) !== 'single') return session;
    return this.metering.billOfflineDrop(session, new Date(report.lockedAt), this.offlineBillCapSeconds);
  }

  /**
   * A paid session whose station dropped on its own, or restarted: staff get a
   * STATION_ATTENTION on the branch dashboard (no automatic penalty).
   */
  private flagAttention(station: StationRef, session: SettlementSession, report: StateReportPayload, now: Date): void {
    if (rateAt(session as Meter, now) <= 0) return;
    const reasons: string[] = [];
    if (this.presence.outageOf(station.serialNumber) === 'single') reasons.push('single_drop');
    if (report.restarted) reasons.push('restarted');
    if (!reasons.length) return;
    this.logger.warn(`station ${station.serialNumber} needs attention (${reasons.join(', ')}) during paid session ${session.id}`);
    this.dashboard.publishToBranch(station.branchId, DASHBOARD_EVENTS.STATION_ATTENTION, {
      machineId: station.machineId,
      serialNumber: station.serialNumber,
      sessionId: session.id,
      reason: reasons[0],
      reasons,
      offlineSince: report.offlineSince ?? null,
      lockedAt: report.lockedAt ?? null,
      lockReason: report.lockReason ?? null,
    });
  }

  /**
   * The billing follow-up of a lock-state / online change seen `at`: metering
   * starts or stops then. Idempotent, and a change already superseded (the
   * station has since reported otherwise) is skipped. Throws so the queue retries.
   */
  async handleStationStatus(event: StationStatusEvent, at: Date): Promise<void> {
    if (event.status === 'OFFLINE') {
      // Back online since: reconnect handling owns that session now.
      if (this.presence.isOnline(event.serialNumber)) return;
      await this.pauseForOffline(event);
      return;
    }
    if (!event.sessionId) return;
    const live = this.presence.agentStateOf(event.serialNumber);
    if (live && live.sessionId === event.sessionId && live.locked !== null && live.locked !== event.locked) return;
    const found = await this.repo.findForSettlement(event.sessionId);
    if (!found || !OPEN_SESSION_STATUSES.includes(found.status)) return;
    const session = await this.metering.foldRateSwitch(found, at);

    if (event.locked === false && session.status !== 'ACTIVE') {
      // The agent binds a session only from an UNLOCK, which only follows an accepted login.
      if (session.status === 'PENDING' && !session.pinUsedAt) return;
      // Every UNLOCK that lifts a staff or funds lock clears its reason first: a station
      // still unlocked from before (a reconnect) does not resume it; reconcile locks it.
      if (session.status === 'PAUSED' && isHeldLock(session.lockReason)) {
        this.logger.warn(`station ${event.serialNumber} reports session ${session.id} unlocked, but it is locked (${session.lockReason})`);
        return;
      }
      await this.repo.activate(session.id, session.reservationId, {
        status: 'ACTIVE',
        meteringStartedAt: at,
        lockedAt: null,
        lockReason: null,
      });
      await this.runout.scheduleRunout({ ...session, status: 'ACTIVE', meteringStartedAt: at, lockedAt: null, lockReason: null });
    } else if (event.locked === true && session.status === 'ACTIVE') {
      await this.metering.pause(session, at, session.lockReason);
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
      // A lock already on its way (staff, funds) keeps its reason: the reconnect must not lift it.
      await this.metering.pause(session, lastSeen, isHeldLock(session.lockReason) ? session.lockReason : OFFLINE_LOCK);
      this.logger.log(`session ${session.id} paused: station ${event.serialNumber} offline since ${event.lastSeen}`);
    }
  }

  /**
   * Settles a session the station ended, at its end time. Idempotent: a
   * session already closed is skipped, the debit key is shared, and the XP is
   * added in the transaction that closes it, so a retried job awards nothing.
   */
  async handleSessionEnded(event: SessionEndedEvent): Promise<void> {
    const session = await this.repo.findForSettlement(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.metering.settle(session, new Date(event.endedAt), event.reason);
  }
}

/** Retried with backoff on failure; done jobs are dropped (the session row is the record), failed ones kept for a look. */
const STATION_EVENT_JOB_OPTIONS = (jobId: string): JobsOptions => ({
  jobId,
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: 1_000,
});

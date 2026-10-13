import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';

import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { DashboardGateway } from '../../ops/dashboard.gateway.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import { PresenceService } from '../../station/services/presence.service.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { exactCostAt, msUntilSpent, rateAt, type Meter } from '../util/metering.js';
import { leaseFor, RUNOUT_LOCK, sessionConfig, type SettlementSession } from '../util/session-rules.js';

import { RunoutTimerService } from './runout-timer.service.js';
import { SessionMeteringService } from './session-metering.service.js';
import { SessionNoticesService } from './session-notices.service.js';

/**
 * When a running session's money runs out: places the WARN/LOCK jobs from
 * what the session has used and what the wallet holds, moves them on every
 * top-up or debit, locks the station when they fire, and resumes a session
 * locked for funds once a top-up covers the minimum play time again.
 */
@Injectable()
export class SessionRunoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionRunoutService.name);
  private readonly subs: Subscription[] = [];
  private readonly leaseCapSeconds: number;
  private readonly runoutMarginS: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly wallet: WalletService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    private readonly dashboard: DashboardGateway,
    private readonly metering: SessionMeteringService,
    private readonly notices: SessionNoticesService,
    config: ConfigService,
  ) {
    const settings = sessionConfig(config);
    this.leaseCapSeconds = settings.leaseCapSeconds;
    this.runoutMarginS = settings.runoutMarginS;
  }

  onModuleInit(): void {
    this.subs.push(
      this.wallet.credited.subscribe((e) => void this.onWalletCredited(e.gamerProfileId)),
      this.wallet.debited.subscribe((e) => void this.onWalletDebited(e.gamerProfileId)),
    );
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
  }

  /**
   * RUNOUT_LOCK_HANDLER seam for feat/runout-timer. Marks the session as
   * locked for funds (so a top-up can resume it) and requests the lock — the
   * PAUSED transition and metering close-out happen through onStationStatus
   * once presence reports the station actually locked, same as a staff LOCK.
   */
  async lockForRunout(sessionId: string): Promise<void> {
    const session = await this.repo.findByIdWithReservation(sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.repo.update(session.id, { lockReason: RUNOUT_LOCK });
    await this.commands.issueSystemLock(session.reservation.machineId, RUNOUT_LOCK);
  }

  /** The runout warning: staff see it on the dashboard, the gamer on the station and in the portal. */
  async warnLowBalance(sessionId: string): Promise<void> {
    const session = await this.repo.findForSettlement(sessionId);
    if (!session || session.status !== 'ACTIVE') return;
    const machine = session.reservation;
    this.dashboard.publishToBranch(machine.machine.branchId, DASHBOARD_EVENTS.SESSION_RUNOUT_WARNING, {
      sessionId,
      machineId: machine.machineId,
    });
    await this.notices.notify(session, 'LOW_BALANCE', await this.lockTime(session));
  }

  /** When this session's money runs out (lock margin included), or null for free play. */
  private async lockTime(session: SettlementSession): Promise<Date | null> {
    const now = new Date();
    const ms = await this.msUntilLock(session, now);
    return Number.isFinite(ms) ? new Date(now.getTime() + ms) : null;
  }

  private async msUntilLock(session: SettlementSession, now: Date): Promise<number> {
    const meter = session as Meter;
    const { balance } = await this.wallet.getWalletForGamer(session.reservation.gamerProfileId);
    // Other running sessions of the gamer's (rare) use the same wallet.
    const others = (await this.repo.findGrantedByGamer(session.reservation.gamerProfileId))
      .filter((s) => s.id !== session.id)
      .reduce((sum, s) => sum + exactCostAt(s as Meter, now), 0);
    const margin = (this.runoutMarginS / 60) * rateAt(meter, now);
    return msUntilSpent(meter, now, balance - others - exactCostAt(meter, now) - margin);
  }

  /** (Re)places the LOCK/WARN jobs from what the session has used and what the wallet holds. */
  async scheduleRunout(session: SettlementSession): Promise<void> {
    if (session.status !== 'ACTIVE') return;
    const lockInMs = await this.msUntilLock(session, new Date());
    await this.runoutTimer.scheduleOrReschedule({
      sessionId: session.id,
      gamerProfileId: session.reservation.gamerProfileId,
      machineId: session.reservation.machineId,
      branchId: session.reservation.machine.branchId,
      serialNumber: session.reservation.machine.serialNumber,
      lockInMs,
    });
  }

  /**
   * A top-up moves the run-out time of a running session. A session the
   * runout timer locked is resumed once the balance covers the minimum play
   * time again: UNLOCK, and metering restarts when the station reports it.
   */
  private async onWalletCredited(gamerProfileId: string): Promise<void> {
    try {
      const session = await this.repo.findActiveByGamer(gamerProfileId);
      if (session) {
        await this.scheduleRunout(session);
        if (!this.runoutTimer.isWithinWarning(await this.msUntilLock(session, new Date()))) await this.notices.notify(session, 'CLEAR');
        return;
      }

      const now = new Date();
      const paused = await this.repo.findPausedByGamer(gamerProfileId, RUNOUT_LOCK, now);
      if (!paused || !(await this.metering.coversMinimumPlay(gamerProfileId, rateAt(paused as Meter, now)))) return;
      if (this.presence.sessionOf(paused.reservation.machine.serialNumber) !== paused.id) return; // the PC moved on
      await this.commands.issueSessionUnlock(
        paused.reservation.machineId,
        { sessionId: paused.id, ...leaseFor(paused, now, this.leaseCapSeconds) },
        'topup',
      );
    } catch (err) {
      this.logger.error(`top-up handling failed for gamer ${gamerProfileId}: ${(err as Error).message}`);
    }
  }

  /** Spending (a plan, a desk debit) brings the run-out time closer. */
  private async onWalletDebited(gamerProfileId: string): Promise<void> {
    try {
      const session = await this.repo.findActiveByGamer(gamerProfileId);
      if (session) await this.scheduleRunout(session);
    } catch (err) {
      this.logger.error(`debit handling failed for gamer ${gamerProfileId}: ${(err as Error).message}`);
    }
  }
}

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionsRepository } from '../repository/sessions.repository.js';
import { sessionConfig } from '../util/session-rules.js';

import { SessionMeteringService } from './session-metering.service.js';
import { SessionNoticesService } from './session-notices.service.js';

/** The periodic pass over sessions and bookings that no station event closes. */
@Injectable()
export class SessionSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionSweepService.name);
  private sweepTimer?: NodeJS.Timeout;

  private readonly sweepIntervalMs: number;
  private readonly noShowGraceMs: number;
  private readonly endingNoticeMs: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly metering: SessionMeteringService,
    private readonly notices: SessionNoticesService,
    config: ConfigService,
  ) {
    const settings = sessionConfig(config);
    this.sweepIntervalMs = settings.sweepIntervalMs;
    this.noShowGraceMs = settings.noShowGraceMs;
    this.endingNoticeMs = settings.endingNoticeMs;
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  /**
   * Every minute: folds due rate switches; closes reservations past their
   * window (a PENDING session nobody logged into is cancelled, any other open
   * session settled at its window end and ended on the station); marks
   * no-shows once the grace after their start has passed; and warns sessions
   * about to reach their end.
   */
  async sweep(): Promise<void> {
    try {
      const now = new Date();
      for (const session of await this.repo.findDueRateSwitches(now)) {
        await this.metering.foldRateSwitch(session, now);
      }
      // No-shows: the PIN's deadline (NO_SHOW_GRACE_MINUTES after the start) passed unused: the station is free again.
      for (const expired of await this.repo.findExpiredUnusedPins(now)) {
        if (await this.repo.expireAsNoShow(expired.id, expired.reservationId)) {
          this.logger.log(`reservation ${expired.reservationId} NO_SHOW: PIN of session ${expired.id} unused by its deadline; station freed`);
        }
      }
      for (const session of await this.repo.findOverdueOpen(now)) {
        if (session.status === 'PENDING' && !session.pinUsedAt) {
          if (await this.repo.closeAsNoShow(session.id, session.reservationId, { unusedPinOnly: true })) {
            this.logger.log(`session ${session.id} cancelled, reservation NO_SHOW: window passed without a login`);
          }
        } else {
          await this.metering.closeOverdue(session);
        }
      }
      // Bookings that never got a PIN (none is issued for them any more, but older rows exist).
      const noShows = await this.repo.markNoShows(now, this.noShowGraceMs);
      if (noShows) this.logger.log(`${noShows} reservation(s) marked NO_SHOW`);

      for (const session of await this.repo.findEndingSoon(now, new Date(now.getTime() + this.endingNoticeMs))) {
        await this.repo.update(session.id, { endingNoticeSentAt: now });
        await this.notices.notify(session, 'TIME_LEFT', session.endTime);
      }
    } catch (err) {
      this.logger.error(`session sweep failed: ${(err as Error).message}`);
    }
  }
}

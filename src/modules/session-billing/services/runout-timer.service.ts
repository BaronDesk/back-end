import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { WalletService } from '../../wallet/services/wallet.service.js';
import {
  RUNOUT_JOBS, RUNOUT_QUEUE, lockJobId, warnJobId,
  type RunoutJobData, type ScheduleRunoutInput,
} from '../schemas/runout-timer.schemas.js';

/**
 * Calculated warn/lock timer for a session's funds: two BullMQ delayed jobs,
 * derived fresh from the gamer's wallet balance and the session's rate every
 * time this is called — on activation and on a wallet top-up alike.
 */
@Injectable()
export class RunoutTimerService {
  private readonly logger = new Logger(RunoutTimerService.name);
  private readonly warnLeadMs: number;

  constructor(
    @InjectQueue(RUNOUT_QUEUE) private readonly queue: Queue<RunoutJobData>,
    private readonly wallet: WalletService,
    config: ConfigService,
  ) {
    this.warnLeadMs = Number(config.get('SESSION_RUNOUT_WARNING_LEAD_S') ?? 300) * 1000;
  }

  async scheduleOrReschedule(input: ScheduleRunoutInput): Promise<void> {
    const { sessionId, rateCentsPerMinute, ...rest } = input;
    const jobData: RunoutJobData = { sessionId, ...rest };

    await this.cancel(sessionId);
    if (!rateCentsPerMinute || rateCentsPerMinute <= 0) return; // free session: never runs out

    const { balance } = await this.wallet.getWalletForGamer(jobData.gamerProfileId);
    const lockDelayMs = Math.max(Math.floor((balance / rateCentsPerMinute) * 60_000), 0);
    const warnDelayMs = Math.max(lockDelayMs - this.warnLeadMs, 0);

    try {
      await this.queue.add(RUNOUT_JOBS.LOCK, jobData, {
        jobId: lockJobId(sessionId), delay: lockDelayMs, removeOnComplete: true, removeOnFail: true,
      });
      if (warnDelayMs < lockDelayMs) {
        await this.queue.add(RUNOUT_JOBS.WARN, jobData, {
          jobId: warnJobId(sessionId), delay: warnDelayMs, removeOnComplete: true, removeOnFail: true,
        });
      }
    } catch (err) {
      this.logger.error(`could not schedule runout timer for session ${sessionId}: ${(err as Error).message}`);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await Promise.all(
      [lockJobId(sessionId), warnJobId(sessionId)].map(async (jobId) => {
        const job = await this.queue.getJob(jobId);
        await job?.remove();
      }),
    );
  }
}
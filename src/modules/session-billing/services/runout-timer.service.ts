import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import {
  RUNOUT_JOBS, RUNOUT_QUEUE, lockJobId, warnJobId,
  type RunoutJobData, type ScheduleRunoutInput,
} from '../schemas/runout-timer.schemas.js';

/**
 * The warn/lock timer for a session's funds: two BullMQ delayed jobs. When
 * the money runs out is SessionsService's to compute (it knows what the
 * session has already used); this only (re)places the jobs.
 */
@Injectable()
export class RunoutTimerService {
  private readonly logger = new Logger(RunoutTimerService.name);
  private readonly warnLeadMs: number;

  constructor(
    @InjectQueue(RUNOUT_QUEUE) private readonly queue: Queue<RunoutJobData>,
    config: ConfigService,
  ) {
    this.warnLeadMs = Number(config.get('SESSION_RUNOUT_WARNING_LEAD_S') ?? 300) * 1000;
  }

  /** Replaces the session's jobs: LOCK in `lockInMs`, WARN the lead before it. Infinity (free play): none. */
  async scheduleOrReschedule(input: ScheduleRunoutInput): Promise<void> {
    const { lockInMs, ...jobData } = input;

    await this.cancel(jobData.sessionId);
    if (!Number.isFinite(lockInMs)) return; // free play: never runs out

    const lockDelayMs = Math.max(Math.floor(lockInMs), 0);
    const warnDelayMs = Math.max(lockDelayMs - this.warnLeadMs, 0);

    try {
      await this.queue.add(RUNOUT_JOBS.LOCK, jobData, {
        jobId: lockJobId(jobData.sessionId), delay: lockDelayMs, removeOnComplete: true, removeOnFail: true,
      });
      if (warnDelayMs < lockDelayMs) {
        await this.queue.add(RUNOUT_JOBS.WARN, jobData, {
          jobId: warnJobId(jobData.sessionId), delay: warnDelayMs, removeOnComplete: true, removeOnFail: true,
        });
      }
    } catch (err) {
      this.logger.error(`could not schedule runout timer for session ${jobData.sessionId}: ${(err as Error).message}`);
    }
  }

  /** Whether the warning would fire right away (the lock is within the lead). */
  isWithinWarning(lockInMs: number): boolean {
    return Number.isFinite(lockInMs) && lockInMs <= this.warnLeadMs;
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

import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { RUNOUT_JOBS, RUNOUT_QUEUE, type RunoutJobData } from '../schemas/runout-timer.schemas.js';
import { SessionsService } from './sessions.service.js';

@Processor(RUNOUT_QUEUE)
export class RunoutTimerProcessor extends WorkerHost {
  private readonly logger = new Logger(RunoutTimerProcessor.name);

  constructor(private readonly sessions: SessionsService) {
    super();
  }

  async process(job: Job<RunoutJobData>): Promise<void> {
    if (job.name === RUNOUT_JOBS.LOCK) {
      await this.sessions.lockForRunout(job.data.sessionId);
      return;
    }
    if (job.name === RUNOUT_JOBS.WARN) {
      await this.sessions.warnLowBalance(job.data.sessionId);
      return;
    }
    this.logger.warn(`unknown runout job name: ${job.name}`);
  }
}

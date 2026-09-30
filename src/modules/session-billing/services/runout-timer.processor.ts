import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { DashboardGateway } from '../../ops/dashboard.gateway.js';
import { RUNOUT_JOBS, RUNOUT_QUEUE, type RunoutJobData } from '../schemas/runout-timer.schemas.js';
import { SessionsService } from './sessions.service.js';

@Processor(RUNOUT_QUEUE)
export class RunoutTimerProcessor extends WorkerHost {
  private readonly logger = new Logger(RunoutTimerProcessor.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly dashboard: DashboardGateway,
  ) {
    super();
  }

  async process(job: Job<RunoutJobData>): Promise<void> {
    if (job.name === RUNOUT_JOBS.LOCK) {
      await this.sessions.lockForRunout(job.data.sessionId);
      return;
    }
    if (job.name === RUNOUT_JOBS.WARN) {
      this.dashboard.publishToBranch(job.data.branchId, DASHBOARD_EVENTS.SESSION_RUNOUT_WARNING, {
        sessionId: job.data.sessionId,
        machineId: job.data.machineId,
      });
      return;
    }
    this.logger.warn(`unknown runout job name: ${job.name}`);
  }
}
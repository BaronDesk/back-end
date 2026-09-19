import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { COMMANDS_QUEUE, CommandJob } from './commands.constants.js';

@Processor(COMMANDS_QUEUE, { concurrency: 5 })
export class CommandProcessor extends WorkerHost {
  private readonly logger = new Logger(CommandProcessor.name);

  async process(job: Job<CommandJob>) {
    this.logger.log(
      `processing ${job.id} attempt ${job.attemptsMade + 1}: ` +
      `${job.data.type} -> ${job.data.machineId}`,
    );

    // Stand-in for the agent-gateway round trip.
    await new Promise((r) => setTimeout(r, 200));

    if (job.data.type == 'fail')
      throw new Error(`simulated failure ID: ${job.data.machineId}`);

    return { ackedAt: new Date().toISOString() };
  }

  @OnWorkerEvent('active')
  onActive(job: Job) {
    this.logger.debug(`active ${job.id}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(`completed ${job.id}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`failed ${job.id} (attempt ${job.attemptsMade}): ${err.message}`);
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) {
    this.logger.warn(`stalled ${jobId} — a worker died mid-job`);
  }
}

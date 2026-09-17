import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { COMMANDS_QUEUE, CommandJob } from './commands.constants.js';

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  constructor(@InjectQueue(COMMANDS_QUEUE) private readonly queue: Queue) {}

  async issue(machineId: string, type: string, payload: unknown) {
    const job = await this.queue.add('command', {
      machineId,
      type,
      payload,
    } satisfies CommandJob);

    this.logger.log(`queued job ${job.id} (${type} -> ${machineId})`);
    return { jobId: job.id };
  }

  // Handy from a controller or a REPL while you are still building things out.
  counts() {
    return this.queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
  }
}

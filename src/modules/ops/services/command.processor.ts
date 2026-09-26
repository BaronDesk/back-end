import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

import { PresenceService } from '../../station/services/presence.service.js';
import { AgentGateway, StationNotConnectedError } from '../agent.gateway.js';
import type { CommandJobData } from '../schemas/command.schemas.js';
import { CommandAckTracker } from './command-ack-tracker.js';
import { COMMAND_QUEUE, CommandsService, OPEN_STATUSES } from './commands.service.js';

/** Thrown to hand the job back to BullMQ for another attempt (same job, same commandId). */
class RetryableCommandError extends Error {}

/**
 * Delivers one command per job and holds the job until the agent answers or
 * the ack timeout fires. Retries only on timeout or a failed socket write,
 * and every retry resends the same commandId: the agent re-acks a command it
 * already ran instead of running it twice. Every other outcome is final and
 * returns normally, so BullMQ never retries it.
 */
@Processor(COMMAND_QUEUE, { concurrency: 16 })
export class CommandProcessor extends WorkerHost {
  private readonly logger = new Logger(CommandProcessor.name);
  private readonly ackTimeoutMs: number;
  private readonly offlineStatus: 'TIMEOUT' | 'FAILED';

  constructor(
    private readonly commands: CommandsService,
    private readonly gateway: AgentGateway,
    private readonly presence: PresenceService,
    private readonly tracker: CommandAckTracker,
    config: ConfigService,
  ) {
    super();
    this.ackTimeoutMs = Number(config.get('COMMAND_ACK_TIMEOUT_MS') ?? 10_000);
    this.offlineStatus = config.get('COMMAND_OFFLINE_STATUS') === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED';
  }

  async process(job: Job<CommandJobData>): Promise<void> {
    const { commandId, simulate } = job.data;
    const command = await this.commands.findById(commandId);
    if (!command || !OPEN_STATUSES.includes(command.status)) return;

    const station = await this.presence.resolveById(command.machineId);
    if (!station) {
      await this.commands.fail(commandId, 'station no longer exists');
      return;
    }

    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

    // Checked before marking SENT so an offline station doesn't burn an attempt.
    if (!this.gateway.isConnected(station.serialNumber)) {
      await this.commands.finish(commandId, this.offlineStatus, 'station not connected at send time');
      return;
    }

    // Persisted before the send: an ack can beat the next line of code here.
    const sending = await this.commands.markSent(commandId);
    if (!sending) return;

    const reply = this.tracker.expect(commandId, this.ackTimeoutMs);
    try {
      await this.gateway.sendCommand(station.serialNumber, command.type, commandId, {}, simulate);
    } catch (err) {
      this.tracker.settle(commandId, { kind: 'timeout' });
      if (err instanceof StationNotConnectedError) {
        await this.commands.finish(commandId, this.offlineStatus, err.message);
        return;
      }
      const reason = `send failed: ${(err as Error).message}`;
      if (lastAttempt) {
        await this.commands.fail(commandId, reason);
        return;
      }
      this.logger.warn(`${command.type} ${commandId} ${reason}; retrying`);
      throw new RetryableCommandError(reason);
    }

    // ack/nack are persisted by CommandsService.onAgentReply before it wakes us.
    const outcome = await reply;
    if (outcome.kind !== 'timeout') return;

    if (!lastAttempt) {
      this.logger.warn(`${command.type} ${commandId}: no ack within ${this.ackTimeoutMs}ms; retrying with same id`);
      throw new RetryableCommandError('ack timeout');
    }
    await this.commands.finish(
      commandId,
      'TIMEOUT',
      `no ack within ${this.ackTimeoutMs}ms after ${sending.attempts} attempt(s)`,
    );
  }

  /** Unplanned errors (DB down, ...) that exhausted every attempt still end the command. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<CommandJobData> | undefined, err: Error): Promise<void> {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    try {
      await this.commands.fail(job.data.commandId, `worker error: ${err.message}`);
    } catch (failErr) {
      this.logger.error(`could not mark ${job.data.commandId} FAILED: ${(failErr as Error).message}`);
    }
  }
}

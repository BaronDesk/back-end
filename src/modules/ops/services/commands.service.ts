import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import { assertScope } from '../../../common/utils/assert-scope.js';
import { SCOPE_RANK } from '../../../common/utils/scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { AgentRegistry } from '../../../infra/realtime/registry.js';
import type { Command, CommandStatus, Prisma } from '../../../generated/prisma/index.js';
import { PresenceService, type StationRef } from '../../station/services/presence.service.js';
import { DashboardGateway } from '../dashboard.gateway.js';
import { CommandsRepository } from '../repository/commands.repository.js';
import {
  NACK_CODES,
  type CommandJobData,
  type IssueCommandBody,
  type ListCommandsQuery,
} from '../schemas/command.schemas.js';
import { CommandAckTracker, type CommandReply } from './command-ack-tracker.js';

export const COMMAND_QUEUE = 'station-commands';

/** A stuck Redis must not hang the POST: past this, the command is FAILED. */
const ENQUEUE_TIMEOUT_MS = 5_000;

/** Statuses a command can still leave. Everything else is terminal. */
export const OPEN_STATUSES: CommandStatus[] = ['PENDING', 'SENT'];

/**
 * An agent reply can land after the timeout already fired: the agent did act,
 * so a late ack/nack still overrides TIMEOUT.
 */
const REPLY_FROM: CommandStatus[] = ['PENDING', 'SENT', 'TIMEOUT'];

/**
 * Nacks that end the command as FAILED. No nack is ever retried:
 * - UNKNOWN_TYPE is deterministic.
 * - EXEC_FAILED is a real handler failure. A resend with the same commandId
 *   only hits the agent's idempotency re-ack (a false success); a new
 *   commandId could run it twice.
 * STALE (and any code a newer agent adds) ends as NACKED.
 */
const FAILED_NACKS: ReadonlySet<string> = new Set([NACK_CODES.UNKNOWN_TYPE, NACK_CODES.EXEC_FAILED]);

/** API and `command_update` shape of a command. */
export function toCommandDto(command: Command) {
  return {
    commandId: command.id,
    machineId: command.machineId,
    branchId: command.branchId,
    type: command.type,
    status: command.status,
    issuedBy: command.issuedBy,
    issuedAt: command.issuedAt.toISOString(),
    sentAt: command.sentAt?.toISOString() ?? null,
    resolvedAt: command.resolvedAt?.toISOString() ?? null,
    attempts: command.attempts,
    nackCode: command.nackCode,
    nackReason: command.nackReason,
    failureReason: command.failureReason,
  };
}

/**
 * Outbound station control. REST creates the COMMAND row and enqueues a job;
 * CommandProcessor delivers it over the agent socket; the gateway hands the
 * agent's reply back here. Every status change goes through `transition`,
 * which is compare-and-set in the DB and pushes `command_update`.
 */
@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly simulationsAllowed: boolean;

  constructor(
    private readonly repo: CommandsRepository,
    private readonly presence: PresenceService,
    private readonly registry: AgentRegistry,
    private readonly dashboard: DashboardGateway,
    private readonly tracker: CommandAckTracker,
    @InjectQueue(COMMAND_QUEUE) private readonly queue: Queue<CommandJobData>,
    private readonly config: ConfigService,
  ) {
    this.simulationsAllowed = config.get('NODE_ENV') !== 'production';
  }

  async issue(caller: AccessTokenPayload, stationId: string, body: IssueCommandBody) {
    // SHUTDOWN powers the machine off: manager+ only. LOCK/UNLOCK are staff+.
    if (body.type === 'SHUTDOWN' && SCOPE_RANK[caller.scope] < SCOPE_RANK.admin) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', error: 'SHUTDOWN requires admin scope' });
    }
    if (body.simulate && !this.simulationsAllowed) {
      throw new BadRequestException({ code: 'SIMULATION_DISABLED', error: 'simulate is dev-only' });
    }

    const station = await this.resolveStation(caller, stationId);
    if (!this.presence.isOnline(station.serialNumber) || !this.registry.has(station.serialNumber)) {
      throw new ConflictException({ code: 'STATION_OFFLINE', error: 'station is not online' });
    }

    const row = await this.repo.create({
      id: randomUUID(),
      machineId: station.machineId,
      branchId: station.branchId,
      type: body.type,
      issuedBy: caller.sub,
    });
    this.logger.log(`${row.type} ${row.id} issued for ${station.serialNumber} by ${caller.sub}`);
    this.publish(row);

    try {
      // TODO(sessions): the booking flow (Member B) will build `payload` from
      // the reservation instead of taking it from the request body.
      await this.enqueue({ commandId: row.id, payload: body.payload, simulate: body.simulate });
    } catch (err) {
      const reason = `enqueue failed: ${(err as Error).message}`;
      this.logger.error(`${row.type} ${row.id}: ${reason}`);
      const failed = await this.fail(row.id, reason);
      return toCommandDto(failed ?? row);
    }
    return toCommandDto(row);
  }

  async list(caller: AccessTokenPayload, stationId: string, query: ListCommandsQuery) {
    const station = await this.resolveStation(caller, stationId);
    const rows = await this.repo.listForMachine(station.machineId, query.limit);
    return rows.map(toCommandDto);
  }

  async get(caller: AccessTokenPayload, commandId: string) {
    const row = await this.repo.findById(commandId);
    if (!row) throw new NotFoundException({ code: 'COMMAND_NOT_FOUND', error: 'command not found' });
    assertScope(caller, { branchId: row.branchId });
    return toCommandDto(row);
  }

  /**
   * command_ack / command_nack from the gateway. Never throws past a log line.
   *
   * An ack means "accepted", not "done": a booking UNLOCK is acked while the
   * station stays locked until the PIN is typed. Nothing here touches lock
   * state. The station's locked flag comes only from presence (heartbeat /
   * state_report).
   */
  async onAgentReply(serialNumber: string, commandId: string, reply: Exclude<CommandReply, { kind: 'timeout' }>) {
    const row = await this.repo.findById(commandId);
    const station = this.presence.resolve(serialNumber);
    if (!row || !station || row.machineId !== station.machineId) {
      this.logger.warn(`${reply.kind} for unknown command ${commandId} from ${serialNumber} ignored`);
      return;
    }

    const now = new Date();
    const data: Prisma.CommandUpdateManyMutationInput =
      reply.kind === 'ack'
        ? { status: 'ACKED', resolvedAt: now }
        : {
            status: FAILED_NACKS.has(reply.code) ? 'FAILED' : 'NACKED',
            resolvedAt: now,
            nackCode: reply.code,
            nackReason: reply.reason,
          };
    const updated = await this.transition(commandId, REPLY_FROM, data);
    if (!updated) {
      this.logger.debug(`${reply.kind} for ${commandId} ignored: already ${row.status}`);
    }
    // Wake the worker last, so it only ever sees the persisted outcome.
    this.tracker.settle(commandId, reply);
  }

  /** Worker: PENDING|SENT -> SENT for one more delivery attempt. Null if it resolved meanwhile. */
  markSent(commandId: string) {
    return this.transition(commandId, OPEN_STATUSES, { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } });
  }

  /** Worker: terminal status for a command that never got a reply. */
  finish(commandId: string, status: 'TIMEOUT' | 'FAILED', failureReason: string) {
    return this.transition(commandId, OPEN_STATUSES, { status, resolvedAt: new Date(), failureReason });
  }

  fail(commandId: string, failureReason: string) {
    return this.finish(commandId, 'FAILED', failureReason);
  }

  findById(commandId: string) {
    return this.repo.findById(commandId);
  }

  private async transition(commandId: string, from: CommandStatus[], data: Prisma.CommandUpdateManyMutationInput) {
    const row = await this.repo.transition(commandId, from, data);
    if (row) {
      this.logger.log(`${row.type} ${row.id} -> ${row.status}${row.nackCode ? ` (${row.nackCode})` : ''}`);
      this.publish(row);
    }
    return row;
  }

  // TODO: Redis pub/sub if multi-instance — in-process publish only reaches
  // dashboards connected to this instance.
  private publish(row: Command): void {
    this.dashboard.publishToBranch(row.branchId, DASHBOARD_EVENTS.COMMAND_UPDATE, toCommandDto(row));
  }

  private async resolveStation(caller: AccessTokenPayload, stationId: string): Promise<StationRef> {
    const station = await this.presence.resolveById(stationId);
    if (!station) throw new NotFoundException({ code: 'STATION_NOT_FOUND', error: 'station not found' });
    assertScope(caller, { branchId: station.branchId });
    return station;
  }

  /**
   * jobId = commandId, so a double enqueue of the same command is a no-op.
   * Retries reuse the job, and with it the commandId the agent dedupes on.
   */
  private async enqueue(data: CommandJobData): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`queue did not answer within ${ENQUEUE_TIMEOUT_MS}ms`)), ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.queue.add('dispatch', data, {
          jobId: data.commandId,
          attempts: Number(this.config.get('COMMAND_MAX_ATTEMPTS') ?? 2),
          backoff: { type: 'fixed', delay: Number(this.config.get('COMMAND_RETRY_BACKOFF_MS') ?? 1_000) },
          // Drop finished jobs: a booking UNLOCK's job data holds the PIN.
          // The COMMAND row is the record of the outcome.
          removeOnComplete: true,
          removeOnFail: true,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

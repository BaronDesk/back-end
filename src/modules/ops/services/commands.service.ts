import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Subscription } from 'rxjs';

import { assertScope } from '../../../common/utils/assert-scope.js';
import { SCOPE_RANK } from '../../../common/utils/scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { AgentRegistry } from '../../../infra/realtime/registry.js';
import type { Command, CommandStatus, Prisma } from '../../../generated/prisma/index.js';
import { GamesService, type CatalogChange } from '../../games/services/games.service.js';
import { PresenceService, type StationRef } from '../../station/services/presence.service.js';
import { DashboardGateway } from '../dashboard.gateway.js';
import { CommandsRepository } from '../repository/commands.repository.js';
import { AuditLogService } from '../../../common/audit/audit-log.service.js';
import {
  NACK_CODES,
  type CommandJobData,
  type CommandPayload,
  type CommandSimulation,
  type IssueCommandBody,
  type SessionUnlockPayload,
  type StationCommandType,
  type ListCommandsQuery,
} from '../schemas/command.schemas.js';
import { CommandAckTracker, type CommandReply } from './command-ack-tracker.js';
import { StationSessionPort } from './station-session.port.js';

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
 * - UNKNOWN_TYPE and INVALID_PAYLOAD are deterministic: the same command gets
 *   the same answer.
 * - EXEC_FAILED is a real handler failure. A resend with the same commandId
 *   only hits the agent's idempotency re-ack (a false success); a new
 *   commandId could run it twice.
 * STALE (and any code a newer agent adds) ends as NACKED.
 */
const FAILED_NACKS: ReadonlySet<string> = new Set([
  NACK_CODES.UNKNOWN_TYPE,
  NACK_CODES.INVALID_PAYLOAD,
  NACK_CODES.EXEC_FAILED,
]);

/** API and `command_update` shape of a command. */
export function toCommandDto(command: Command) {
  return {
    commandId: command.id,
    machineId: command.machineId,
    branchId: command.branchId,
    type: command.type,
    gameId: command.gameId,
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
/** Simulations that replace the wire LAUNCH_GAME to provoke an agent-side rejection. */
const AGENT_REJECTION_SIMULATIONS: ReadonlySet<CommandSimulation> = new Set(['invalid_payload', 'exec_failed']);

/** Nil UUID: commands issued by the system, no staff caller (e.g. a runout lock). Same "no FK" reasoning as any other issuedBy. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';


@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandsService.name);
  private readonly simulationsAllowed: boolean;
  private catalogSub?: Subscription;

  constructor(
    private readonly repo: CommandsRepository,
    private readonly presence: PresenceService,
    private readonly registry: AgentRegistry,
    private readonly dashboard: DashboardGateway,
    private readonly tracker: CommandAckTracker,
    @InjectQueue(COMMAND_QUEUE) private readonly queue: Queue<CommandJobData>,
    private readonly config: ConfigService,
    private readonly games: GamesService,
    private readonly sessions: StationSessionPort,
    private readonly audit: AuditLogService,
  ) {
    this.simulationsAllowed = config.get('NODE_ENV') !== 'production';
  }

  onModuleInit(): void {
    this.catalogSub = this.games.catalogChanges.subscribe((change) => void this.requestCatalogSync(change));
  }

  onModuleDestroy(): void {
    this.catalogSub?.unsubscribe();
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

    // Every rejection happens here, before a row exists or anything is queued.
    let payload: CommandPayload | undefined;
    let gameId: string | undefined;
    if (body.type === 'LAUNCH_GAME') {
      const wireGameId = body.gameId!;
      payload = { gameId: wireGameId };
      if (!body.simulate || !AGENT_REJECTION_SIMULATIONS.has(body.simulate)) {
        // The agent refuses the launch while locked or without a session.
        const agent = this.presence.agentStateOf(station.serialNumber);
        if (agent?.locked !== false || !agent.sessionId) {
          throw new ConflictException({
            code: 'STATION_NOT_IN_SESSION',
            error: 'station must be unlocked with an active session to launch a game',
          });
        }
        gameId = (await this.games.findLaunchable(station, wireGameId)).id;
      }
    } else if (body.type === 'END_SESSION') {
      if (!this.presence.sessionOf(station.serialNumber)) {
        throw new ConflictException({ code: 'NO_ACTIVE_SESSION', error: 'station has no active session' });
      }
      payload = body.reason ? { reason: body.reason } : {};
    } else if (body.type === 'UNLOCK' && !body.simulate) {
      // The agent only unlocks for a session: resume the station's own one (409 without).
      const sessions = this.sessions.current;
      if (!sessions) throw new ConflictException({ code: 'NO_SESSION_TO_UNLOCK', error: 'sessions are unavailable' });
      payload = await sessions.unlockFor(station);
    } else if (body.type === 'SHUTDOWN') {
      // The gamer stops playing now: settle before the PC goes dark (its session end arrives later, already closed).
      await this.sessions.current?.closeForShutdown(station);
      await this.audit.record(caller.sub, 'UPDATE', `machine:${station.machineId}`, {
        branchId: station.branchId,
        metadata: { event: 'STATION_SHUTDOWN' },
      });
    }

    // Labels the session.ended event, which fires only once the agent reports
    // the session gone. The agent also stops the running game itself: no
    // separate stop command. Billing close-out is Member B's, not ours.
    if (body.type === 'END_SESSION') this.presence.expectSessionEnd(station.serialNumber, body.reason ?? 'normal');

    return this.dispatch(station, body.type, caller.sub, { payload, gameId, simulate: body.simulate });
  }

  /**
   * CATALOG_UPDATE for every online station whose resolved catalog changed,
   * so the agent re-pulls GET /stations/me/games now instead of on its next
   * reconnect. Offline stations need nothing: they sync on connect. Never
   * throws: this runs from a subscription.
   */
  async requestCatalogSync(change: CatalogChange): Promise<void> {
    const targets = this.presence
      .onlineStations()
      .filter((s) => change.branchIds.includes(s.branchId) || change.machineIds.includes(s.machineId))
      .filter((s) => this.registry.has(s.serialNumber));
    for (const station of targets) {
      try {
        // One pending sync is enough: the agent pulls the latest catalog when it runs.
        if (await this.repo.hasOpen(station.machineId, 'CATALOG_UPDATE')) continue;
        await this.dispatch(station, 'CATALOG_UPDATE', change.issuedBy, { payload: {} });
      } catch (err) {
        this.logger.error(`CATALOG_UPDATE for ${station.serialNumber} not issued: ${(err as Error).message}`);
      }
    }
  }

  /** Creates the COMMAND row, pushes it, and queues its delivery. */
  private async dispatch(
    station: StationRef,
    type: StationCommandType,
    issuedBy: string,
    options: { payload?: CommandPayload; gameId?: string; simulate?: CommandSimulation },
  ) {
    const row = await this.repo.create({
      id: randomUUID(),
      machineId: station.machineId,
      branchId: station.branchId,
      type,
      issuedBy,
      gameId: options.gameId,
    });
    this.logger.log(`${row.type} ${row.id} issued for ${station.serialNumber} by ${issuedBy}`);
    this.publish(row);

    try {
      await this.enqueue({ commandId: row.id, payload: options.payload, simulate: options.simulate });
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
   * station stays locked until the PIN is typed. A LAUNCH_GAME ack does mean
   * the process was started, but runningGameId still comes only from the
   * agent's state_report (sent on its next reconnect), never from here.
   * Nothing here touches station state: locked / sessionId / runningGameId
   * come only from presence (heartbeat / state_report).
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
          // Drop finished jobs: the COMMAND row is the record of the outcome.
          removeOnComplete: true,
          removeOnFail: true,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** System-issued LOCK, bypassing the caller-scope checks in issue() — used by session-billing when a session's funds run out. */
  async issueSystemLock(machineId: string, reason: string): Promise<void> {
    await this.issueSystem(machineId, 'LOCK', reason);
  }

  /**
   * Session UNLOCK { sessionId, leaseSeconds, serverTime }. Session-billing
   * issues it only after an accepted login_result, or to resume a session the
   * station reports on reconnect. Station state still comes only from presence.
   */
  async issueSessionUnlock(machineId: string, payload: SessionUnlockPayload, reason: string): Promise<boolean> {
    return this.issueSystem(machineId, 'UNLOCK', reason, payload);
  }

  /**
   * System END_SESSION for a session that ended or ran past its window. Only
   * while the station reports that very session (END_SESSION ends whatever
   * the PC runs, so it must never reach the next gamer's session), and one
   * open END_SESSION per station is enough. Settlement follows presence's
   * session.ended as for any other end.
   */
  async issueSystemEndSession(machineId: string, reason: string, sessionId: string): Promise<boolean> {
    return this.issueSystem(machineId, 'END_SESSION', reason, { reason }, async (station) => {
      if (this.presence.sessionOf(station.serialNumber) !== sessionId) return false;
      if (await this.repo.hasOpen(station.machineId, 'END_SESSION')) return false;
      this.presence.expectSessionEnd(station.serialNumber, reason);
      return true;
    });
  }

  /** Dispatches a SYSTEM_ACTOR_ID command to an online station; false (logged) when it cannot be delivered. */
  private async issueSystem(
    machineId: string,
    type: StationCommandType,
    reason: string,
    payload?: CommandPayload,
    /** Last check before dispatch; false skips the command. */
    beforeDispatch?: (station: StationRef) => Promise<boolean>,
  ): Promise<boolean> {
    const station = await this.presence.resolveById(machineId);
    if (!station) {
      this.logger.warn(`system ${type} for ${machineId} skipped: station not found (${reason})`);
      return false;
    }
    if (!this.presence.isOnline(station.serialNumber) || !this.registry.has(station.serialNumber)) {
      this.logger.warn(`system ${type} for ${station.serialNumber} skipped: station offline (${reason})`);
      return false;
    }
    if (beforeDispatch && !(await beforeDispatch(station))) return false;
    await this.dispatch(station, type, SYSTEM_ACTOR_ID, { payload });
    return true;
  }

}

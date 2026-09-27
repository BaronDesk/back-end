import type { IncomingMessage } from 'node:http';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Subscription } from 'rxjs';
import { WebSocketServer, WebSocket } from 'ws';

import {
  AGENT_COMMANDS,
  AGENT_MESSAGE_TYPES,
  DASHBOARD_EVENTS,
  SERVER_MESSAGE_TYPES,
} from '../../infra/realtime/constants.js';
import { makeFrame, OutboundSequencer, parseFrame } from '../../infra/realtime/frame.js';
import { AgentRegistry } from '../../infra/realtime/registry.js';
import { SeqGuard } from '../../infra/realtime/seq-guard.js';
import type { Envelope } from '../../infra/realtime/envelope.js';
import {
  handshakePayloadSchema,
  heartbeatPayloadSchema,
  stateReportPayloadSchema,
} from '../station/schemas/presence.schemas.js';
import {
  PresenceService,
  StationIdentityMismatchError,
  UnknownStationError,
} from '../station/services/presence.service.js';
import { bearerToken, StationAuthService } from '../station/services/station-auth.service.js';
import { InvalidStationTokenError, type StationPrincipal } from '../station/services/station-token.service.js';
import { catalogStatusPayloadSchema } from '../games/schemas/games.schemas.js';
import { GamesService } from '../games/services/games.service.js';
import { DashboardGateway } from './dashboard.gateway.js';
import {
  commandAckPayloadSchema,
  commandNackPayloadSchema,
  NACK_CODES,
  type CommandSimulation,
  type StationCommandType,
} from './schemas/command.schemas.js';
import { deviceEventPayloadSchema, telemetryPayloadSchema } from './schemas/telemetry.schemas.js';
import { CommandsService } from './services/commands.service.js';
import { TelemetryService } from './services/telemetry.service.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;

/** RFC 6455 policy violation: the station's credential does not fit the connection. */
const CLOSE_POLICY_VIOLATION = 1008;

/** `simulate: 'stale_ts'` backdates the frame well past any replay window. */
const SIMULATED_STALE_MS = 10 * 60_000;

/**
 * Wire LAUNCH_GAME payloads for the agent-rejection simulations: an empty
 * gameId (INVALID_PAYLOAD) and one no catalog contains (EXEC_FAILED).
 */
const SIMULATED_LAUNCH_PAYLOADS: Partial<Record<CommandSimulation, Record<string, unknown>>> = {
  invalid_payload: { gameId: '' },
  exec_failed: { gameId: 'simulated-not-in-catalog' },
};

/** No live, handshaken socket for the station at send time. */
export class StationNotConnectedError extends Error {
  constructor(serialNumber: string) {
    super(`station ${serialNumber} is not connected`);
  }
}

/**
 * The agent stamps these from its TelemetryService's own sequence counter,
 * not the connection counter used for handshake/heartbeat/state_report. The
 * two interleave, so each stream gets its own SeqGuard: one shared guard
 * would drop whichever stream lags behind.
 */
const TELEMETRY_STREAM_TYPES: ReadonlySet<string> = new Set([
  AGENT_MESSAGE_TYPES.TELEMETRY,
  AGENT_MESSAGE_TYPES.DEVICE_EVENT,
]);

interface AgentConnection {
  ip: string | null;
  /**
   * Who the verified station token says this is, from the upgrade request.
   * null only under STATION_AUTH_DEV_BYPASS (the handshake serial decides).
   */
  principal: StationPrincipal | null;
  /** `Authorization: Bearer` from the upgrade request; kept for the dev bypass's REST binding. */
  bearerToken: string | null;
  seqGuard: SeqGuard;
  telemetrySeqGuard: SeqGuard;
  outbound: OutboundSequencer;
  /** Set once the handshake has been resolved to a MACHINE row. */
  serialNumber?: string;
  /** Resolves when the handshake completes; later frames wait on it. */
  ready?: Promise<boolean>;
  handshakeTimer?: NodeJS.Timeout;
}

/**
 * Raw `ws` server for machine agents, attached directly to Nest's underlying
 * HTTP server (no @nestjs/websockets — that would pull in socket.io for a
 * channel that must speak the plain agent wire protocol).
 *
 * Station identity is the station JWT on the upgrade request
 * (`Authorization: Bearer`), verified before the upgrade completes; a missing
 * or invalid token gets a 401 and never becomes a socket. The handshake's
 * `serialNumber` must match the token's. Presence itself lives in the station
 * module; this gateway only translates frames into PresenceService calls.
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private wss?: WebSocketServer;
  private statusSub?: Subscription;
  private readonly connections = new WeakMap<WebSocket, AgentConnection>();
  /** Upgrade request -> its verified principal, from verifyClient to 'connection'. */
  private readonly principals = new WeakMap<IncomingMessage, StationPrincipal | null>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: AgentRegistry,
    private readonly presence: PresenceService,
    private readonly dashboard: DashboardGateway,
    private readonly telemetry: TelemetryService,
    private readonly commands: CommandsService,
    private readonly games: GamesService,
    private readonly stationAuth: StationAuthService,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer();

    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/agent-ws',
      verifyClient: (info, done) => void this.verifyUpgrade(info.req, done),
    });
    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) =>
      this.handleConnection(socket, request),
    );

    this.statusSub = this.presence.statusChanges.subscribe((event) =>
      this.dashboard.publishToBranch(event.branchId, DASHBOARD_EVENTS.STATION_STATUS, event),
    );
    this.logger.log('agent-ws attached at /agent-ws');
  }

  onModuleDestroy(): void {
    this.statusSub?.unsubscribe();
    this.wss?.close();
  }

  /** Runs before the upgrade completes: no valid station token, no socket. */
  private async verifyUpgrade(
    request: IncomingMessage,
    done: (result: boolean, code?: number, message?: string) => void,
  ): Promise<void> {
    try {
      this.principals.set(request, await this.stationAuth.authenticateAgent(request.headers.authorization));
      done(true);
    } catch (err) {
      const invalid = err instanceof InvalidStationTokenError;
      this.logger.warn(`agent-ws upgrade rejected (${remoteIp(request)}): ${(err as Error).message}`);
      done(false, invalid ? 401 : 500, invalid ? 'Unauthorized' : 'Internal Server Error');
    }
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const principal = this.principals.get(request);
    this.principals.delete(request);
    if (principal === undefined) {
      // Only reachable if verifyClient was bypassed; never serve an unverified socket.
      socket.close(CLOSE_POLICY_VIOLATION, 'unauthenticated');
      return;
    }

    const conn: AgentConnection = {
      ip: remoteIp(request),
      principal,
      bearerToken: bearerToken(request.headers.authorization),
      seqGuard: new SeqGuard(),
      telemetrySeqGuard: new SeqGuard(),
      outbound: new OutboundSequencer(),
    };
    conn.handshakeTimer = setTimeout(() => socket.close(4408, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS);
    this.connections.set(socket, conn);

    socket.on('message', (data: Buffer) => void this.handleMessage(socket, data));
    socket.on('close', () => void this.handleClose(socket));
    socket.on('error', (err: Error) =>
      this.logger.warn(`agent socket error (${conn.serialNumber ?? conn.ip}): ${err.message}`),
    );
  }

  private async handleClose(socket: WebSocket): Promise<void> {
    const conn = this.connections.get(socket);
    if (!conn) return;
    clearTimeout(conn.handshakeTimer);

    const serial = conn.serialNumber;
    if (!serial) return;
    this.logger.log(`agent disconnected: ${serial}`);

    // A newer connection for the same station already replaced this one.
    if (!this.registry.deregister(serial, socket)) return;

    try {
      await this.presence.disconnect(serial);
    } catch (err) {
      this.logger.error(`failed to mark ${serial} offline: ${(err as Error).message}`);
    }
  }

  private async handleMessage(socket: WebSocket, data: Buffer): Promise<void> {
    const conn = this.connections.get(socket);
    if (!conn) return;

    let envelope: Envelope;
    try {
      envelope = parseFrame(data);
    } catch {
      socket.close(4400, 'malformed envelope');
      return;
    }

    // Checked synchronously on arrival so async handlers can't reorder seqs.
    // No nack: the agent answers unknown frame types with its own nack.
    const guard = TELEMETRY_STREAM_TYPES.has(envelope.type) ? conn.telemetrySeqGuard : conn.seqGuard;
    const result = guard.check(envelope);
    if (!result.ok) {
      this.logger.warn(
        `dropped ${envelope.type} from ${conn.serialNumber ?? conn.ip}: ${result.reason} (seq ${envelope.seq})`,
      );
      return;
    }

    try {
      if (envelope.type === AGENT_MESSAGE_TYPES.HANDSHAKE) {
        await this.onHandshake(socket, conn, envelope);
        return;
      }

      if (!conn.ready || !(await conn.ready) || !conn.serialNumber) {
        this.logger.warn(`ignored ${envelope.type} before handshake (${conn.ip})`);
        return;
      }

      switch (envelope.type) {
        case AGENT_MESSAGE_TYPES.HEARTBEAT:
          await this.onHeartbeat(socket, conn, conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.STATE_REPORT:
          await this.onStateReport(conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.TELEMETRY:
          await this.onTelemetry(conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.DEVICE_EVENT:
          await this.onDeviceEvent(conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.COMMAND_ACK:
          await this.onCommandAck(conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.COMMAND_NACK:
          await this.onCommandNack(conn.serialNumber, envelope);
          return;
        case AGENT_MESSAGE_TYPES.CATALOG_STATUS:
          await this.onCatalogStatus(conn.serialNumber, envelope);
          return;
        default:
          this.logger.debug(`ignored unhandled frame type '${envelope.type}' from ${conn.serialNumber}`);
      }
    } catch (err) {
      this.logger.error(`error handling ${envelope.type} from ${conn.serialNumber ?? conn.ip}: ${(err as Error).message}`);
    }
  }

  private async onHandshake(socket: WebSocket, conn: AgentConnection, envelope: Envelope): Promise<void> {
    const parsed = handshakePayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      socket.close(4400, 'invalid handshake payload');
      return;
    }
    const handshake = parsed.data;

    if (conn.principal && handshake.serialNumber !== conn.principal.serialNumber) {
      this.logger.warn(
        `rejected agent: handshake serial ${handshake.serialNumber} != token serial ${conn.principal.serialNumber} (${conn.ip})`,
      );
      socket.close(CLOSE_POLICY_VIOLATION, 'serial number does not match station token');
      return;
    }

    if (conn.serialNumber && conn.serialNumber !== handshake.serialNumber) {
      socket.close(4409, 'serial number changed mid-connection');
      return;
    }

    const ready = this.presence.connect(handshake, conn.ip, conn.principal).then(
      () => true,
      (err: Error) => {
        if (err instanceof StationIdentityMismatchError) {
          this.logger.warn(`rejected agent: ${err.message} (${conn.ip})`);
          socket.close(CLOSE_POLICY_VIOLATION, 'station token does not match the station');
        } else if (err instanceof UnknownStationError) {
          this.logger.warn(`rejected agent: ${err.message} (${conn.ip})`);
          socket.close(4403, 'unknown station');
        } else {
          this.logger.error(`handshake failed for ${handshake.serialNumber}: ${err.message}`);
          socket.close(1011, 'handshake failed');
        }
        return false;
      },
    );
    conn.ready = ready;
    if (!(await ready)) return;

    clearTimeout(conn.handshakeTimer);
    if (socket.readyState !== WebSocket.OPEN) {
      // Closed while we were resolving the machine; undo the ONLINE mark.
      await this.presence.disconnect(handshake.serialNumber);
      return;
    }

    conn.serialNumber = handshake.serialNumber;
    this.registry.register(handshake.serialNumber, socket);
    // Dev bypass only: lets GET /stations/me/games recognise a serial-identified agent by its token.
    if (!conn.principal) this.stationAuth.bindDevToken(conn.bearerToken, handshake.serialNumber);
    const identity = conn.principal
      ? `machine ${conn.principal.machineId}, branch ${conn.principal.branchId}`
      : 'UNVERIFIED, dev bypass';
    this.logger.log(
      `agent connected: ${handshake.serialNumber} [${identity}] (${handshake.machineName ?? '?'}, v${handshake.agentVersion ?? '?'}) from ${conn.ip}`,
    );
    this.send(socket, conn, SERVER_MESSAGE_TYPES.HANDSHAKE_ACK, {});
  }

  private async onHeartbeat(
    socket: WebSocket,
    conn: AgentConnection,
    serialNumber: string,
    envelope: Envelope,
  ): Promise<void> {
    const parsed = heartbeatPayloadSchema.safeParse(envelope.payload);
    if (parsed.success) {
      await this.presence.touch(serialNumber, parsed.data);
    } else {
      this.logger.warn(`malformed heartbeat payload from ${serialNumber}`);
    }
    // Always ack: the agent derives its session lease from heartbeat_ack
    // (null => its default lease).
    this.send(socket, conn, SERVER_MESSAGE_TYPES.HEARTBEAT_ACK, { leaseExpiresAt: null });
  }

  private async onStateReport(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = stateReportPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn(`malformed state_report payload from ${serialNumber}`);
      return;
    }
    await this.presence.reportState(serialNumber, parsed.data);
  }

  // telemetry and device_event get no ack: the agent does not expect one.
  // telemetry is live-only; device_event is retried by the agent on reconnect
  // and deduplicated downstream.
  private async onTelemetry(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = telemetryPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn(`malformed telemetry payload from ${serialNumber}`);
      return;
    }
    await this.telemetry.ingest(serialNumber, parsed.data);
  }

  private async onDeviceEvent(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = deviceEventPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn(`malformed device_event payload from ${serialNumber}`);
      return;
    }
    await this.telemetry.onDeviceEvent(serialNumber, parsed.data);
  }

  private async onCommandAck(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = commandAckPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn(`malformed command_ack payload from ${serialNumber}`);
      return;
    }
    await this.commands.onAgentReply(serialNumber, parsed.data.commandId, { kind: 'ack' });
  }

  private async onCommandNack(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = commandNackPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      this.logger.warn(`malformed command_nack payload from ${serialNumber}`);
      return;
    }
    const { commandId, code, reason } = parsed.data;
    const line = `command_nack ${code} for ${commandId} from ${serialNumber}${reason ? `: ${reason}` : ''}`;
    // INVALID_PAYLOAD means we sent a malformed command: a backend bug that
    // validation should have caught. EXEC_FAILED is normal operational traffic.
    if (code === NACK_CODES.INVALID_PAYLOAD) this.logger.error(`${line} (backend sent a malformed command)`);
    else if (code === NACK_CODES.EXEC_FAILED) this.logger.log(line);
    else this.logger.warn(line);
    await this.commands.onAgentReply(serialNumber, commandId, { kind: 'nack', code, reason: reason ?? null });
  }

  /** catalog_status: after every catalog sync, what this station can actually launch. */
  private async onCatalogStatus(serialNumber: string, envelope: Envelope): Promise<void> {
    const parsed = catalogStatusPayloadSchema.safeParse(envelope.payload);
    const station = this.presence.resolve(serialNumber);
    if (!parsed.success || !station) {
      this.logger.warn(`malformed catalog_status payload from ${serialNumber}`);
      return;
    }
    const status = await this.games.recordStationStatus(station, parsed.data);
    this.dashboard.publishToBranch(station.branchId, DASHBOARD_EVENTS.CATALOG_STATUS, status);
  }

  isConnected(serialNumber: string): boolean {
    return this.registry.get(serialNumber)?.readyState === WebSocket.OPEN;
  }

  /**
   * Delivers a command on the station's live socket. The envelope type is the
   * command name and its id is the commandId (same id on every resend); seq
   * and ts are stamped here, at send time, by that connection's sequencer,
   * because the agent's ReplayGuard nacks anything stale or out of order.
   */
  async sendCommand(
    serialNumber: string,
    type: StationCommandType,
    commandId: string,
    payload: Record<string, unknown> = {},
    simulate?: CommandSimulation,
  ): Promise<void> {
    const socket = this.registry.get(serialNumber);
    const conn = socket && this.connections.get(socket);
    if (!socket || !conn || conn.serialNumber !== serialNumber || socket.readyState !== WebSocket.OPEN) {
      throw new StationNotConnectedError(serialNumber);
    }

    // invalid_payload / exec_failed: a LAUNCH_GAME the agent is sure to reject.
    const simulatedLaunch = simulate ? SIMULATED_LAUNCH_PAYLOADS[simulate] : undefined;
    const wireType = simulatedLaunch ? AGENT_COMMANDS.LAUNCH_GAME : type;
    const envelope = conn.outbound.next(wireType, simulatedLaunch ?? payload, commandId);
    if (simulate === 'stale_ts') envelope.ts = new Date(Date.now() - SIMULATED_STALE_MS).toISOString();
    await sendFrame(socket, makeFrame(envelope));

    if (simulate === 'duplicate_send') {
      await sendFrame(socket, makeFrame(conn.outbound.next(type, payload, commandId)));
    }
  }

  private send(socket: WebSocket, conn: AgentConnection, type: string, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(makeFrame(conn.outbound.next(type, payload)));
  }
}

function sendFrame(socket: WebSocket, frame: string): Promise<void> {
  return new Promise((resolve, reject) => socket.send(frame, (err) => (err ? reject(err) : resolve())));
}

/** Caddy terminates TLS in front of us, so prefer the proxy's client-IP headers. */
function remoteIp(request: IncomingMessage): string | null {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() || undefined;
  };
  const ip = header('x-real-ip') ?? header('x-forwarded-for') ?? request.socket.remoteAddress ?? null;
  return ip?.replace(/^::ffff:/, '') ?? null;
}

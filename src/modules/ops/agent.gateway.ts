import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Subscription } from 'rxjs';
import { WebSocketServer, WebSocket } from 'ws';

import {
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
import { PresenceService, UnknownStationError } from '../station/services/presence.service.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { deviceEventPayloadSchema, telemetryPayloadSchema } from './schemas/telemetry.schemas.js';
import { TelemetryService } from './services/telemetry.service.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const AGENT_WS_PATH = '/agent-ws';

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
 * Station identity is the `serialNumber` in the `handshake` frame, not a
 * query parameter. Presence itself lives in the station module; this gateway
 * only translates frames into PresenceService calls.
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private wss?: WebSocketServer;
  private httpServer?: HttpServer;
  private statusSub?: Subscription;
  private readonly connections = new WeakMap<WebSocket, AgentConnection>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: AgentRegistry,
    private readonly presence: PresenceService,
    private readonly dashboard: DashboardGateway,
    private readonly telemetry: TelemetryService,
  ) {}

  onModuleInit(): void {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;

    // noServer: with `{ server, path }`, ws answers every other upgrade on the
    // shared HTTP server with a 400, which corrupts Socket.IO's /dashboard-io
    // handshake. Only claim our own path and leave the rest to Socket.IO.
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on('upgrade', this.onUpgrade);
    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) =>
      this.handleConnection(socket, request),
    );

    this.statusSub = this.presence.statusChanges.subscribe((event) =>
      this.dashboard.publishToBranch(event.branchId, DASHBOARD_EVENTS.STATION_STATUS, event),
    );
    this.logger.log(`agent-ws attached at ${AGENT_WS_PATH}`);
  }

  onModuleDestroy(): void {
    this.statusSub?.unsubscribe();
    this.httpServer?.off('upgrade', this.onUpgrade);
    this.wss?.close();
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const wss = this.wss;
    if (!wss || new URL(request.url ?? '/', 'http://localhost').pathname !== AGENT_WS_PATH) return;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };

  // STUB: verifyStation per ADR-003 goes here. The agent may send
  // `Authorization: Bearer <stationToken>`; it is ignored until station
  // credentials exist.
  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const conn: AgentConnection = {
      ip: remoteIp(request),
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

    if (conn.serialNumber && conn.serialNumber !== handshake.serialNumber) {
      socket.close(4409, 'serial number changed mid-connection');
      return;
    }

    const ready = this.presence.connect(handshake, conn.ip).then(
      () => true,
      (err: Error) => {
        if (err instanceof UnknownStationError) {
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
    this.logger.log(
      `agent connected: ${handshake.serialNumber} (${handshake.machineName ?? '?'}, v${handshake.agentVersion ?? '?'}) from ${conn.ip}`,
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

  private send(socket: WebSocket, conn: AgentConnection, type: string, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(makeFrame(conn.outbound.next(type, payload)));
  }
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

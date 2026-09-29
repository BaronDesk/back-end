import type { IncomingMessage } from 'node:http';

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type WebSocket } from 'ws';

import { makeFrame, parseFrame } from '../../infra/realtime/frame.js';
import { AgentRegistry } from '../../infra/realtime/registry.js';
import { SeqGuard } from '../../infra/realtime/seq-guard.js';
import type { Envelope } from '../../infra/realtime/envelope.js';
import { MachinesRepository } from '../machines/repository/machines.repository.js';
import { TokenService } from '../identity/services/token.service.js';

interface AgentConnection {
  machineId: string;
  seqGuard: SeqGuard;
}

/**
 * Raw `ws` server for machine agents, attached directly to Nest's underlying
 * HTTP server (no @nestjs/websockets — that would pull in socket.io for a
 * channel that must speak the plain agent wire protocol).
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private wss?: WebSocketServer;
  private readonly connections = new WeakMap<WebSocket, AgentConnection>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly registry: AgentRegistry,
    private readonly machines: MachinesRepository,
    private readonly tokens: TokenService,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer();

    this.wss = new WebSocketServer({ server: httpServer, path: '/agent-ws' });
    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) =>
      void this.handleConnection(socket, request),
    );
    this.logger.log('agent-ws attached at /agent-ws');
  }

  onModuleDestroy(): void {
    this.wss?.close();
  }

  private async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? '', 'http://internal');
    const machineId = url.searchParams.get('machineId');
    const token = url.searchParams.get('token');

    if (!machineId || !token) {
      socket.close(4401, 'missing station credentials');
      return;
    }

    try {
      const claims = await this.tokens.verifyStationToken(token);
      const machine = await this.machines.findById(machineId);
      if (
        claims.sub !== machineId ||
        !machine ||
        machine.enrollmentStatus !== 'ENROLLED' ||
        machine.serialNumber !== claims.serialNumber ||
        machine.branchId !== claims.branchId
      ) {
        socket.close(4401, 'invalid station credentials');
        return;
      }
    } catch {
      socket.close(4401, 'invalid station credentials');
      return;
    }

    this.connections.set(socket, { machineId, seqGuard: new SeqGuard() });
    this.registry.register(machineId, socket);
    this.logger.log(`agent connected: ${machineId}`);

    socket.on('message', (data: Buffer) => this.handleMessage(socket, data));
    socket.on('close', () => {
      this.registry.deregister(machineId, socket);
      this.logger.log(`agent disconnected: ${machineId}`);
    });
    socket.on('error', (err: Error) => this.logger.warn(`agent socket error (${machineId}): ${err.message}`));
  }

  private handleMessage(socket: WebSocket, data: Buffer): void {
    const conn = this.connections.get(socket);
    if (!conn) return;

    let envelope: Envelope;
    try {
      envelope = parseFrame(data);
    } catch {
      socket.close(4400, 'malformed envelope');
      return;
    }

    const result = conn.seqGuard.check(envelope);
    if (!result.ok) {
      socket.send(makeFrame(this.reply(envelope, `${envelope.type}_nack`, { reason: result.reason })));
      return;
    }

    // No business logic yet for any message type — every well-formed,
    // non-replayed envelope gets a generic ack to keep the wire alive.
    socket.send(makeFrame(this.reply(envelope, `${envelope.type}_ack`, {})));
  }

  private reply(envelope: Envelope, type: string, payload: unknown): Envelope {
    return { type, id: envelope.id, ts: Date.now(), seq: envelope.seq, payload };
  }
}

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Server, type Socket } from 'socket.io';

import type { DashboardEvent } from '../../infra/realtime/constants.js';
import { TokenService } from '../identity/services/token.service.js';

function branchRoom(branchId: string): string {
  return `branch:${branchId}`;
}

/**
 * Socket.IO gateway for staff dashboards. Authenticates at connect by
 * reusing identity's TokenService — the same claim verification the HTTP
 * JwtAuthGuard uses — rather than re-implementing JWT checks here.
 */
@Injectable()
export class DashboardGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardGateway.name);
  private io?: Server;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: TokenService,
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer();

    this.io = new Server(httpServer, { path: '/dashboard-io' });
    this.io.use((socket, next) => {
      this.authenticate(socket)
        .then(() => next())
        .catch((err: Error) => next(err));
    });
    this.io.on('connection', (socket) => this.handleConnection(socket));
    this.logger.log('dashboard-io attached at /dashboard-io');
  }

  onModuleDestroy(): void {
    this.io?.close();
  }

  private async authenticate(socket: Socket): Promise<void> {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      (socket.handshake.query?.token as string | undefined);

    if (!token) throw new Error('missing token');

    socket.data.user = await this.tokens.verifyAccessToken(token);
  }

  private handleConnection(socket: Socket): void {
    const user = socket.data.user;
    const room = user.branchId ? branchRoom(user.branchId) : 'branch:all';
    void socket.join(room);
    this.logger.log(`dashboard connected: ${user.sub} -> ${room}`);
  }

  publishToBranch(branchId: string | null, event: DashboardEvent, payload: unknown): void {
    if (!this.io) return;

    if (!branchId) {
      this.io.to('branch:all').emit(event, payload);
      return;
    }
    this.io.to(branchRoom(branchId)).to('branch:all').emit(event, payload);
  }
}

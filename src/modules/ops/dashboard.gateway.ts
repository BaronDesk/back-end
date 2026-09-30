import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Server, type Socket } from 'socket.io';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { SCOPE_RANK } from '../../common/utils/scope.js';
import type { DashboardEvent } from '../../infra/realtime/constants.js';
import { TokenService } from '../identity/services/token.service.js';

function branchRoom(branchId: string): string {
  return `branch:${branchId}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Every branch's events: HQ only. */
const ALL_BRANCHES_ROOM = 'branch:all';

/**
 * Socket.IO gateway for the staff dashboards and the gamer portal.
 * Authenticates at connect by reusing identity's TokenService — the same
 * claim verification the HTTP JwtAuthGuard uses.
 *
 * Rooms keep each caller to what they may see: staff get their branch's
 * events, HQ every branch's, and a gamer only the events addressed to them
 * (`user:<id>`) — never a station, command or alert event.
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
    const user = socket.data.user as AccessTokenPayload;
    const room = roomFor(user);
    if (!room) {
      this.logger.warn(`dashboard refused: ${user.sub} (${user.scope}) has no branch`);
      socket.disconnect(true);
      return;
    }
    void socket.join(room);
    this.logger.log(`dashboard connected: ${user.sub} -> ${room}`);
  }

  /** A branch's event: that branch's staff and HQ. `null` (a branch-less record): HQ only. */
  publishToBranch(branchId: string | null, event: DashboardEvent, payload: unknown): void {
    if (!this.io) return;

    if (!branchId) {
      this.io.to(ALL_BRANCHES_ROOM).emit(event, payload);
      return;
    }
    this.io.to(branchRoom(branchId)).to(ALL_BRANCHES_ROOM).emit(event, payload);
  }

  /** An event for one user (a gamer's own session): only their sockets. */
  publishToUser(userId: string, event: DashboardEvent, payload: unknown): void {
    this.io?.to(userRoom(userId)).emit(event, payload);
  }
}

/** HQ: every branch. Other staff: their branch (none without one). Gamers: their own room. */
export function roomFor(user: AccessTokenPayload): string | null {
  if (SCOPE_RANK[user.scope] < SCOPE_RANK.staff) return userRoom(user.sub);
  if (user.scope === 'hq') return ALL_BRANCHES_ROOM;
  return user.branchId ? branchRoom(user.branchId) : null;
}

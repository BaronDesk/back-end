import type { Server as HttpServer } from "node:http";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { Server as SocketIOServer, Socket } from "socket.io";
import { TokenService } from "../../security/token.service";
import { AuthContext } from "../../shared/types/auth";
import { DashboardEvent } from "../../shared/types/realtime";

declare module "socket.io" {
  interface Socket {
    auth: AuthContext;
  }
}

function branchRoom(branchId: string | null): string {
  return branchId ? `branch:${branchId}` : "branch:all";
}

/**
 * Socket.IO transport for dashboards, on path `/dashboard-io`. Clients
 * authenticate with the same access token as the REST API
 * (`handshake.auth.token`) and are placed in their branch's room (`hq`, or a
 * null branchId, joins `branch:all`).
 *
 * Business logic pushes events with `publishToBranch()` — inject this class
 * (exported by OpsModule) wherever you need it.
 */
@Injectable()
export class DashboardGateway implements OnModuleInit, OnModuleDestroy {
  private io?: SocketIOServer;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(TokenService) private readonly tokens: TokenService
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    const io = new SocketIOServer(httpServer, { path: "/dashboard-io" });

    io.use((socket, next) => {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        return next(new Error("UNAUTHORIZED"));
      }

      try {
        const claims = this.tokens.verifyAccessToken(token);
        socket.auth = {
          sub: claims.sub,
          role: claims.role,
          scope: claims.scope,
          branchId: claims.branchId,
          jti: claims.jti,
        };
        next();
      } catch {
        next(new Error("UNAUTHORIZED"));
      }
    });

    io.on("connection", (socket: Socket) => {
      const room = socket.auth.scope === "hq" ? "branch:all" : branchRoom(socket.auth.branchId);
      socket.join(room);

      socket.emit("hello", { sub: socket.auth.sub, scope: socket.auth.scope, room });

      socket.on("ping", () => {
        socket.emit("pong", { ts: new Date().toISOString() });
      });
    });

    this.io = io;
  }

  onModuleDestroy(): void {
    // Not io.close(): that would also close the HTTP server, which Nest/Fastify
    // closes itself right after the destroy hooks.
    this.io?.disconnectSockets(true);
    this.io?.engine.close();
  }

  publishToBranch<T>(branchId: string | null, event: DashboardEvent, payload: T): void {
    this.io?.to(branchRoom(branchId)).emit(event, payload);
  }
}

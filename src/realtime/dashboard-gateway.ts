import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { AccessTokenClaims, AuthContext } from "../common/auth/scope.js";
import { DashboardEvent } from "./realtime.types.js";

declare module "socket.io" {
  interface Socket {
    auth: AuthContext;
  }
}

function branchRoom(branchId: string | null): string {
  return branchId ? `branch:${branchId}` : "branch:all";
}

export function initDashboardGateway(
  httpServer: HttpServer,
  verifyAccessToken: (token: string) => AccessTokenClaims
): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    path: "/dashboard-io",
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      return next(new Error("UNAUTHORIZED"));
    }

    try {
      const claims = verifyAccessToken(token);
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

  return io;
}

export function publishToBranch<T>(
  io: SocketIOServer,
  branchId: string | null,
  event: DashboardEvent,
  payload: T
): void {
  io.to(branchRoom(branchId)).emit(event, payload);
}

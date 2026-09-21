import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocket, WebSocketServer } from "ws";
import { makeFrame, parseFrame, SeqGuard } from "../../lib/realtime/envelope";
import { MachineRegistry } from "../../lib/realtime/registry";
import { AGENT_MESSAGES, AgentMessageType } from "../../shared/types/realtime";
import { AppError } from "../../lib/app-error";

const AGENT_PATH = "/agent-ws";

interface Station {
  machineId: string;
}

function isAgentMessageType(type: string): type is AgentMessageType {
  return (AGENT_MESSAGES as readonly string[]).includes(type);
}

/**
 * Raw-`ws` transport for machine agents: `GET /agent-ws?machineId&token`.
 *
 * Nest allows only one WebSocket adapter per app and this project has two
 * transports (this one + Socket.IO for dashboards), so the agent socket is a
 * plain provider that handles the HTTP `upgrade` event for its own path.
 * Everything else (envelope framing, SeqGuard anti-replay) is unchanged.
 */
@Injectable()
export class AgentGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentGateway.name);
  private httpServer?: HttpServer;
  private wss?: WebSocketServer;
  private upgradeListener?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(MachineRegistry) private readonly registry: MachineRegistry
  ) {}

  onModuleInit(): void {
    const httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (socket, req) => this.onConnection(socket, req));

    this.upgradeListener = (req, socket, head) => {
      if (this.pathOf(req) !== AGENT_PATH) return; // not ours (e.g. Socket.IO's /dashboard-io)
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    };
    httpServer.on("upgrade", this.upgradeListener);

    this.httpServer = httpServer;
    this.wss = wss;
  }

  onModuleDestroy(): void {
    if (this.upgradeListener) this.httpServer?.off("upgrade", this.upgradeListener);
    this.wss?.clients.forEach((client) => client.terminate());
    this.wss?.close();
  }

  private pathOf(req: IncomingMessage): string {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  }

  /**
   * Stub: real implementation should verify `token` against the machine's
   * enrolled agent credentials (see Machine.agentPublicKey) and confirm
   * `machineId` matches. For now it only checks both params are present.
   */
  private verifyStation(req: IncomingMessage): Station | null {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const machineId = query.get("machineId");
    const token = query.get("token");
    if (!machineId || !token) return null;
    return { machineId };
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const station = this.verifyStation(req);
    if (!station) {
      socket.close(4401, "Missing machineId or token");
      return;
    }

    const { machineId } = station;
    const guard = new SeqGuard();
    let outboundSeq = 0;
    const reply = (type: string, payload: unknown) =>
      socket.send(JSON.stringify(makeFrame(type, payload, outboundSeq++)));

    this.registry.add(machineId, socket);
    this.logger.log(`agent connected machineId=${machineId}`);

    socket.on("message", (raw) => {
      let envelope;
      try {
        envelope = parseFrame(raw.toString());
      } catch (err) {
        reply("error", { message: err instanceof AppError ? err.message : "Invalid frame" });
        return;
      }

      const guardResult = guard.check(envelope);
      if (!guardResult.ok) {
        reply("command_nack", { reason: guardResult.reason, of: envelope.id });
        return;
      }

      if (!isAgentMessageType(envelope.type)) {
        reply("command_nack", { reason: "UNKNOWN_TYPE", of: envelope.id });
        return;
      }

      switch (envelope.type) {
        case "handshake":
          reply("handshake_ack", { of: envelope.id });
          break;
        case "heartbeat":
          reply("heartbeat_ack", { of: envelope.id });
          break;
        default:
          // telemetry / alert / command_ack / command_nack / state_report:
          // no business logic yet, just acknowledge receipt.
          reply("ack", { of: envelope.id });
      }
    });

    socket.on("close", () => {
      this.registry.remove(machineId, socket);
      this.logger.log(`agent disconnected machineId=${machineId}`);
    });
  }
}

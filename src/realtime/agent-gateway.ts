import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import websocketPlugin from "@fastify/websocket";
import { makeFrame, parseFrame, SeqGuard } from "../../lib/realtime/envelope";
import { machineRegistry } from "../../lib/realtime/registry";
import { AGENT_MESSAGES, AgentMessageType } from "../../shared/types/realtime";
import { AppError } from "../../lib/app-error";

interface StationQuery {
  machineId?: string;
  token?: string;
}

/**
 * Stub: real implementation should verify `token` against the machine's
 * enrolled agent credentials (see Machine.agentPublicKey) and confirm
 * `machineId` matches. For now it only checks both params are present.
 */
function verifyStation(req: FastifyRequest): { machineId: string } | null {
  const { machineId, token } = req.query as StationQuery;
  if (!machineId || !token) return null;
  return { machineId };
}

function isAgentMessageType(type: string): type is AgentMessageType {
  return (AGENT_MESSAGES as readonly string[]).includes(type);
}

export const agentGateway: FastifyPluginAsync = async (app) => {
  await app.register(websocketPlugin);

  app.get("/agent-ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const station = verifyStation(req);
    if (!station) {
      socket.close(4401, "Missing machineId or token");
      return;
    }

    const { machineId } = station;
    const guard = new SeqGuard();
    let outboundSeq = 0;

    machineRegistry.add(machineId, socket);
    app.log.info({ machineId }, "agent connected");

    socket.on("message", (raw) => {
      let envelope;
      try {
        envelope = parseFrame(raw.toString());
      } catch (err) {
        const message = err instanceof AppError ? err.message : "Invalid frame";
        socket.send(JSON.stringify(makeFrame("error", { message }, outboundSeq++)));
        return;
      }

      const guardResult = guard.check(envelope);
      if (!guardResult.ok) {
        socket.send(
          JSON.stringify(
            makeFrame("command_nack", { reason: guardResult.reason, of: envelope.id }, outboundSeq++)
          )
        );
        return;
      }

      if (!isAgentMessageType(envelope.type)) {
        socket.send(
          JSON.stringify(makeFrame("command_nack", { reason: "UNKNOWN_TYPE", of: envelope.id }, outboundSeq++))
        );
        return;
      }

      switch (envelope.type) {
        case "handshake":
          socket.send(JSON.stringify(makeFrame("handshake_ack", { of: envelope.id }, outboundSeq++)));
          break;
        case "heartbeat":
          socket.send(JSON.stringify(makeFrame("heartbeat_ack", { of: envelope.id }, outboundSeq++)));
          break;
        default:
          // telemetry / alert / command_ack / command_nack / state_report:
          // no business logic yet, just acknowledge receipt.
          socket.send(JSON.stringify(makeFrame("ack", { of: envelope.id }, outboundSeq++)));
      }
    });

    socket.on("close", () => {
      machineRegistry.remove(machineId, socket);
      app.log.info({ machineId }, "agent disconnected");
    });
  });
};

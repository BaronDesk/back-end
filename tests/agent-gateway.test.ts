import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../src/app";

function send(ws: WebSocket, type: string, payload: unknown, seq: number) {
  ws.send(JSON.stringify({ type, id: randomUUID(), ts: new Date().toISOString(), seq, payload }));
}

test("agent gateway: handshake_ack, heartbeat_ack, and replayed seq is nacked", async () => {
  const app = await createApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  const machineId = randomUUID();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent-ws?machineId=${machineId}&token=dev-token`);

  const received: Array<{ type: string; payload: any }> = [];
  let heartbeatFrame: unknown;
  let replayed = false;

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      send(ws, "handshake", { machineId, agentVersion: "test", branchId: randomUUID() }, 0);
    });

    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      received.push(frame);

      if (frame.type === "handshake_ack") {
        heartbeatFrame = {
          type: "heartbeat",
          id: randomUUID(),
          ts: new Date().toISOString(),
          seq: 1,
          payload: { status: "idle", uptimeSeconds: 0 },
        };
        ws.send(JSON.stringify(heartbeatFrame));
      } else if (frame.type === "heartbeat_ack" && !replayed) {
        replayed = true;
        ws.send(JSON.stringify(heartbeatFrame));
      } else if (frame.type === "command_nack") {
        resolve();
      }
    });

    ws.on("error", reject);
  });

  expect(received.some((f) => f.type === "handshake_ack")).toBe(true);
  expect(received.some((f) => f.type === "heartbeat_ack")).toBe(true);

  const nack = received.find((f) => f.type === "command_nack");
  expect(nack).toBeTruthy();
  expect(nack.payload.reason).toBe("SEQ_REPLAYED");

  ws.close();
  await app.close();
});

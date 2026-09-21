import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { UserRole } from "@prisma/client";
import { DashboardGateway } from "../src/modules/ops/dashboard-gateway";
import { startTestServer, tokensOf } from "./helpers/app";

test("dashboard gateway: authenticates, joins its branch room, and receives a published event", async () => {
  const { app, port } = await startTestServer();

  const branchId = randomUUID();
  const { token } = tokensOf(app).signAccessToken({ id: randomUUID(), role: UserRole.MANAGER, branchId });

  const socket: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
    path: "/dashboard-io",
    auth: { token },
    reconnection: false,
  });

  const hello = await new Promise<{ sub: string; scope: string; room: string }>((resolve, reject) => {
    socket.on("hello", resolve);
    socket.on("connect_error", reject);
  });

  expect(hello.room).toBe(`branch:${branchId}`);

  const eventPayload = await new Promise((resolve) => {
    socket.once("telemetry_update", resolve);
    app.get(DashboardGateway).publishToBranch(branchId, "telemetry_update", { machineId: "m1", metric: "cpu", value: 42 });
  });

  expect(eventPayload).toEqual({ machineId: "m1", metric: "cpu", value: 42 });

  socket.close();
  await app.close();
});

test("dashboard gateway: rejects a connection with no token", async () => {
  const { app, port } = await startTestServer();

  const socket: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
    path: "/dashboard-io",
    reconnection: false,
  });

  const err = await new Promise<Error>((resolve) => {
    socket.on("connect_error", resolve);
    socket.on("connect", () => resolve(new Error("should not have connected")));
  });

  expect(err.message).toMatch(/UNAUTHORIZED/);

  socket.close();
  await app.close();
});

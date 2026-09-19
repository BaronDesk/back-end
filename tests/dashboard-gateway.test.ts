import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { UserRole } from "@prisma/client";
import { createApp } from "../src/app";
import { initDashboardGateway, publishToBranch } from "../src/modules/ops/dashboard-gateway";
import { signAccessToken } from "../src/lib/jwt";

test("dashboard gateway: authenticates, joins its branch room, and receives a published event", async () => {
  const app = await createApp();
  const io = initDashboardGateway(app.server);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  const branchId = randomUUID();
  const { token } = signAccessToken({ id: randomUUID(), role: UserRole.MANAGER, branchId });

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
    publishToBranch(io, branchId, "telemetry_update", { machineId: "m1", metric: "cpu", value: 42 });
  });

  expect(eventPayload).toEqual({ machineId: "m1", metric: "cpu", value: 42 });

  socket.close();
  io.close();
  await app.close();
});

test("dashboard gateway: rejects a connection with no token", async () => {
  const app = await createApp();
  const io = initDashboardGateway(app.server);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

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
  io.close();
  await app.close();
});

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../../src/app.module";
import { configureApp } from "../../src/app.setup";
import { PrismaService } from "../../src/prisma/prisma.service";
import { TokenService } from "../../src/security/token.service";
import { hashPassword } from "../../src/lib/password";
import { db, fakePrisma } from "./db";

export { db };

export const BRANCH_A = "11111111-1111-4111-8111-111111111111";
export const BRANCH_B = "22222222-2222-4222-8222-222222222222";
export const PASSWORD = "Password123!";
export const API = "/api/v1";

/**
 * Boots the real AppModule (guards, pipes, filters, gateways) with Prisma
 * swapped for the in-memory fake. Same configureApp() as main.ts.
 */
async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(fakePrisma)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await configureApp(app);
  await app.init();
  return app;
}

/** For HTTP tests via `app.inject()` — no port is opened. */
export async function buildTestApp(): Promise<NestFastifyApplication> {
  const app = await createTestApp();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** For WebSocket / Socket.IO tests — listens on an ephemeral port. */
export async function startTestServer(): Promise<{ app: NestFastifyApplication; port: number }> {
  const app = await createTestApp();
  await app.listen(0, "127.0.0.1");
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port };
}

/** The app's TokenService, for tests that need to read or sign tokens directly. */
export const tokensOf = (app: NestFastifyApplication) => app.get(TokenService);

export interface SeedOptions {
  username: string;
  role: "GAMER" | "EMPLOYEE" | "MANAGER" | "ADMIN";
  branchId?: string;
  accountStatus?: "ACTIVE" | "SUSPENDED";
}

/** Inserts a user straight into the fake DB (bypasses the API). */
export async function seedUser(opts: SeedOptions) {
  const id = randomUUID();
  const now = new Date();
  db().users.push({
    id,
    username: opts.username,
    passwordHash: await hashPassword(PASSWORD),
    role: opts.role,
    accountStatus: opts.accountStatus ?? "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  if (opts.branchId) {
    db().employeeProfiles.push({
      userId: id,
      managedBranchId: opts.branchId,
      employmentStatus: "ACTIVE",
      hireDate: now,
    });
  }
  return { id, username: opts.username, password: PASSWORD };
}

export interface Session {
  id: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

export async function loginAs(
  app: NestFastifyApplication,
  user: { id: string; username: string; password: string }
): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: `${API}/auth/login`,
    payload: { username: user.username, password: user.password },
  });
  expect(res.statusCode, `login failed: ${res.body}`).toBe(200);
  const body = res.json();
  return { id: user.id, username: user.username, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** One user per role/branch, all logged in. Used by the RBAC integration tests. */
export async function setupWorld(app: NestFastifyApplication) {
  const mk = async (opts: SeedOptions) => loginAs(app, await seedUser(opts));
  return {
    gamer: await mk({ username: "gamer_one", role: "GAMER" }),
    otherGamer: await mk({ username: "gamer_two", role: "GAMER" }),
    employeeA: await mk({ username: "emp_a", role: "EMPLOYEE", branchId: BRANCH_A }),
    managerA: await mk({ username: "mgr_a", role: "MANAGER", branchId: BRANCH_A }),
    managerB: await mk({ username: "mgr_b", role: "MANAGER", branchId: BRANCH_B }),
    admin: await mk({ username: "root_admin", role: "ADMIN" }),
  };
}
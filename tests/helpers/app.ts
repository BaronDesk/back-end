import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { hashPassword } from "../../src/lib/password";
import type { FakePrisma } from "./fake-prisma";

export const BRANCH_A = "11111111-1111-4111-8111-111111111111";
export const BRANCH_B = "22222222-2222-4222-8222-222222222222";
export const PASSWORD = "Password123!";
export const API = "/api/v1";

export const db = () => (prisma as unknown as FakePrisma).__db;

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = await createApp();
  await app.ready();
  return app;
}

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
  app: FastifyInstance,
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
export async function setupWorld(app: FastifyInstance) {
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
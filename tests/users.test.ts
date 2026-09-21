import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  API,
  BRANCH_A,
  BRANCH_B,
  PASSWORD,
  bearer,
  buildTestApp,
  db,
  loginAs,
  seedUser,
  setupWorld,
} from "./helpers/app";

let app: NestFastifyApplication;
let w: Awaited<ReturnType<typeof setupWorld>>;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  w = await setupWorld(app); // runs after the automatic DB reset
});

const call = (method: "GET" | "POST" | "PATCH", url: string, token?: string, payload?: object) =>
  app.inject({ method, url: `${API}${url}`, headers: token ? bearer(token) : {}, payload });

const employeeBody = (over: Record<string, unknown> = {}) => ({
  branchId: BRANCH_A,
  username: "new_employee",
  password: PASSWORD,
  role: "EMPLOYEE",
  ...over,
});

describe("POST /users (public signup)", () => {
  it("creates a GAMER account without authentication, and it can log in", async () => {
    const res = await call("POST", "/users", undefined, { username: "newbie", password: PASSWORD });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ username: "newbie", role: "GAMER", accountStatus: "ACTIVE" });
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");

    const login = await loginAs(app, {
      id: res.json().user.id,
      username: "newbie",
      password: PASSWORD,
    });
    expect(login.accessToken).toBeTruthy();
  });

  it("ignores a smuggled role (no privilege escalation via signup)", async () => {
    const res = await call("POST", "/users", undefined, {
      username: "sneaky",
      password: PASSWORD,
      role: "ADMIN",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("GAMER");
  });

  it("rejects duplicate usernames", async () => {
    const res = await call("POST", "/users", undefined, { username: "gamer_one", password: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("USERNAME_TAKEN");
  });

  it("validates input", async () => {
    const res = await call("POST", "/users", undefined, { username: "x", password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("hashes the password (never stores plain text)", async () => {
    await call("POST", "/users", undefined, { username: "hashed_one", password: PASSWORD });
    const stored = db().users.find((u) => u.username === "hashed_one")!;
    expect(stored.passwordHash).not.toBe(PASSWORD);
    expect(stored.passwordHash).toMatch(/^\$(argon2(id|i|d)|2[aby])\$/);
  });
});

describe("GET /users/:id", () => {
  it("requires authentication", async () => {
    const res = await call("GET", `/users/${w.gamer.id}`);
    expect(res.statusCode).toBe(401);
  });

  it("lets a gamer read their own profile", async () => {
    const res = await call("GET", `/users/${w.gamer.id}`, w.gamer.accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("gamer_one");
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");
  });

  it("blocks a gamer from reading another gamer", async () => {
    const res = await call("GET", `/users/${w.otherGamer.id}`, w.gamer.accessToken);
    expect(res.statusCode).toBe(403);
  });

  it("lets staff, managers and admins read any user", async () => {
    for (const s of [w.employeeA, w.managerA, w.admin]) {
      const res = await call("GET", `/users/${w.gamer.id}`, s.accessToken);
      expect(res.statusCode).toBe(200);
    }
  });

  it("returns 404 for a missing user and 400 for a malformed id", async () => {
    const missing = await call("GET", `/users/${randomUUID()}`, w.admin.accessToken);
    expect(missing.statusCode).toBe(404);
    const bad = await call("GET", `/users/not-a-uuid`, w.admin.accessToken);
    expect(bad.statusCode).toBe(400);
  });
});

describe("POST /employees", () => {
  it("is forbidden to gamers and plain employees", async () => {
    for (const s of [w.gamer, w.employeeA]) {
      const res = await call("POST", "/employees", s.accessToken, employeeBody());
      expect(res.statusCode).toBe(403);
    }
  });

  it("requires authentication", async () => {
    const res = await call("POST", "/employees", undefined, employeeBody());
    expect(res.statusCode).toBe(401);
  });

  it("lets a manager create an EMPLOYEE in their own branch", async () => {
    const res = await call("POST", "/employees", w.managerA.accessToken, employeeBody());
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("EMPLOYEE");
    const profile = db().employeeProfiles.find((p) => p.userId === res.json().user.id);
    expect(profile?.managedBranchId).toBe(BRANCH_A);
  });

  it("blocks a manager from creating staff in another branch", async () => {
    const res = await call("POST", "/employees", w.managerA.accessToken, employeeBody({ branchId: BRANCH_B }));
    expect(res.statusCode).toBe(403);
  });

  it("blocks a manager from creating a MANAGER (role escalation)", async () => {
    const res = await call("POST", "/employees", w.managerA.accessToken, employeeBody({ role: "MANAGER" }));
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ROLE_ESCALATION_DENIED");
  });

  it("lets an admin create a MANAGER in any branch", async () => {
    const res = await call("POST", "/employees", w.admin.accessToken, employeeBody({ role: "MANAGER", branchId: BRANCH_B }));
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("MANAGER");
  });

  it("does not allow creating ADMIN accounts through this endpoint", async () => {
    const res = await call("POST", "/employees", w.admin.accessToken, employeeBody({ role: "ADMIN" }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects duplicate usernames", async () => {
    const res = await call("POST", "/employees", w.admin.accessToken, employeeBody({ username: "emp_a" }));
    expect(res.statusCode).toBe(409);
  });
});

describe("PATCH /users/:id/role", () => {
  it("is forbidden to gamers and plain employees", async () => {
    for (const s of [w.gamer, w.employeeA]) {
      const res = await call("PATCH", `/users/${w.otherGamer.id}/role`, s.accessToken, { role: "EMPLOYEE" });
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets an admin change any user's role", async () => {
    const res = await call("PATCH", `/users/${w.gamer.id}/role`, w.admin.accessToken, { role: "MANAGER" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("MANAGER");
    expect(db().users.find((u) => u.id === w.gamer.id)!.role).toBe("MANAGER");
  });

  it("blocks a manager from granting MANAGER or ADMIN", async () => {
    for (const role of ["MANAGER", "ADMIN"]) {
      const res = await call("PATCH", `/users/${w.employeeA.id}/role`, w.managerA.accessToken, { role });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ROLE_ESCALATION_DENIED");
    }
  });

  it("lets a manager change roles within their own branch", async () => {
    const res = await call("PATCH", `/users/${w.employeeA.id}/role`, w.managerA.accessToken, { role: "GAMER" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("GAMER");
  });

  it("blocks a manager from touching users in another branch", async () => {
    const other = await seedUser({ username: "emp_b", role: "EMPLOYEE", branchId: BRANCH_B });
    const res = await call("PATCH", `/users/${other.id}/role`, w.managerA.accessToken, { role: "GAMER" });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 for an unknown user and 400 for an invalid role", async () => {
    const missing = await call("PATCH", `/users/${randomUUID()}/role`, w.admin.accessToken, { role: "GAMER" });
    expect(missing.statusCode).toBe(404);
    const bad = await call("PATCH", `/users/${w.gamer.id}/role`, w.admin.accessToken, { role: "SUPERUSER" });
    expect(bad.statusCode).toBe(400);
  });
});
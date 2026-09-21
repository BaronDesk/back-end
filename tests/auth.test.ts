import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { API, BRANCH_A, PASSWORD, bearer, buildTestApp, db, loginAs, seedUser, tokensOf } from "./helpers/app";

let app: NestFastifyApplication;
beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `${API}${url}`, payload: payload as object, headers });

describe("server basics", () => {
  it("GET /health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("unknown routes return 404 ROUTE_NOT_FOUND", async () => {
    const res = await app.inject({ method: "GET", url: `${API}/nope` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ROUTE_NOT_FOUND");
  });

  it("malformed JSON returns a 4xx, not a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${API}/auth/login`,
      headers: { "content-type": "application/json" },
      payload: "{bad json",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("returns tokens and the user on valid credentials", async () => {
    const u = await seedUser({ username: "alice", role: "GAMER" });
    const res = await post("/auth/login", { username: "alice", password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.user).toEqual({ id: u.id, username: "alice", role: "GAMER" });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("stores the refresh token and writes an audit-log entry", async () => {
    await seedUser({ username: "alice", role: "GAMER" });
    await post("/auth/login", { username: "alice", password: PASSWORD });
    expect(db().refreshTokens).toHaveLength(1);
    expect(db().auditLogs).toHaveLength(1);
    expect(db().auditLogs[0].action).toBe("LOGIN");
  });

  it("rejects a wrong password", async () => {
    await seedUser({ username: "alice", role: "GAMER" });
    const res = await post("/auth/login", { username: "alice", password: "WrongPassword!" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("gives the same error for an unknown username (no user enumeration)", async () => {
    await seedUser({ username: "alice", role: "GAMER" });
    const wrongPw = await post("/auth/login", { username: "alice", password: "WrongPassword!" });
    const unknown = await post("/auth/login", { username: "ghost_user", password: PASSWORD });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrongPw.json());
  });

  it("rejects suspended accounts", async () => {
    await seedUser({ username: "bob", role: "GAMER", accountStatus: "SUSPENDED" });
    const res = await post("/auth/login", { username: "bob", password: PASSWORD });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("validates the request body", async () => {
    const res = await post("/auth/login", { username: "al", password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("JWT contents", () => {
  it("access token carries sub, role, scope, branchId, jti, issuer and a 15 min lifetime", async () => {
    const u = await seedUser({ username: "mgr", role: "MANAGER", branchId: BRANCH_A });
    const { accessToken } = await loginAs(app, u);

    const claims = tokensOf(app).verifyAccessToken(accessToken);
    expect(claims).toMatchObject({ sub: u.id, role: "MANAGER", scope: "admin", branchId: BRANCH_A });
    expect(claims.jti).toEqual(expect.any(String));

    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    expect(payload.iss).toBe("cstam-identity-test");
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  it("gamers get branchId null and scope self", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const { accessToken } = await loginAs(app, u);
    expect(tokensOf(app).verifyAccessToken(accessToken)).toMatchObject({ scope: "self", branchId: null });
  });
});

describe("GET /auth/me", () => {
  it("requires a token", async () => {
    const res = await app.inject({ method: "GET", url: `${API}/auth/me` });
    expect(res.statusCode).toBe(401);
  });

  it("returns id, role and branchId for a valid token", async () => {
    const u = await seedUser({ username: "emp", role: "EMPLOYEE", branchId: BRANCH_A });
    const s = await loginAs(app, u);
    const res = await app.inject({ method: "GET", url: `${API}/auth/me`, headers: bearer(s.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: u.id, role: "EMPLOYEE", branchId: BRANCH_A } });
  });

  it("rejects garbage and tampered tokens", async () => {
    const u = await seedUser({ username: "emp", role: "EMPLOYEE", branchId: BRANCH_A });
    const s = await loginAs(app, u);
    const tampered = s.accessToken.slice(0, -4) + (s.accessToken.endsWith("AAAA") ? "BBBB" : "AAAA");

    for (const token of ["garbage", tampered]) {
      const res = await app.inject({ method: "GET", url: `${API}/auth/me`, headers: bearer(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("INVALID_ACCESS_TOKEN");
    }
  });

  it("rejects an access token after its 15 minute lifetime", async () => {
    const u = await seedUser({ username: "emp", role: "EMPLOYEE", branchId: BRANCH_A });
    const s = await loginAs(app, u);

    // Sanity check: the token works right now.
    const ok = await app.inject({ method: "GET", url: `${API}/auth/me`, headers: bearer(s.accessToken) });
    expect(ok.statusCode).toBe(200);

    // Jump the clock 16 minutes ahead. Only Date is faked, so timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);
      const res = await app.inject({ method: "GET", url: `${API}/auth/me`, headers: bearer(s.accessToken) });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("INVALID_ACCESS_TOKEN");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept a refresh token as an access token (separate secrets)", async () => {
    const u = await seedUser({ username: "emp", role: "EMPLOYEE", branchId: BRANCH_A });
    const s = await loginAs(app, u);
    const res = await app.inject({ method: "GET", url: `${API}/auth/me`, headers: bearer(s.refreshToken) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_ACCESS_TOKEN");
  });
});

describe("POST /auth/refresh", () => {
  it("rotates: returns a new pair and revokes the old refresh token", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const s = await loginAs(app, u);

    const res = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.refreshToken).not.toBe(s.refreshToken);

    // old token is now dead (reuse detection)
    const reuse = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().code).toBe("REFRESH_TOKEN_REVOKED");

    // the new one works, and the old row links to its replacement
    const again = await post("/auth/refresh", { refreshToken: next.refreshToken });
    expect(again.statusCode).toBe(200);
    expect(db().refreshTokens.filter((t) => t.revoked)).toHaveLength(2);
    expect(db().refreshTokens[0].replacedByJti).toEqual(expect.any(String));
  });

  it("does not accept an access token as a refresh token", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const s = await loginAs(app, u);
    const res = await post("/auth/refresh", { refreshToken: s.accessToken });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("refuses to refresh for an account suspended after login", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const s = await loginAs(app, u);
    db().users.find((x) => x.id === u.id)!.accountStatus = "SUSPENDED";
    const res = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("ACCOUNT_INACTIVE");
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session's refresh token", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const s = await loginAs(app, u);

    const out = await post("/auth/logout", { refreshToken: s.refreshToken }, bearer(s.accessToken));
    expect(out.statusCode).toBe(204);

    const res = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("REFRESH_TOKEN_REVOKED");
    expect(db().auditLogs.map((a) => a.action)).toContain("LOGOUT");
  });

  it("requires authentication", async () => {
    const res = await post("/auth/logout", { jti: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(401);
  });

  it("needs a jti or refreshToken", async () => {
    const u = await seedUser({ username: "gam", role: "GAMER" });
    const s = await loginAs(app, u);
    const res = await post("/auth/logout", {}, bearer(s.accessToken));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("MISSING_TOKEN_REFERENCE");
  });

  it("cannot revoke another user's session", async () => {
    const a = await loginAs(app, await seedUser({ username: "user_a", role: "GAMER" }));
    const b = await loginAs(app, await seedUser({ username: "user_b", role: "GAMER" }));
    const res = await post("/auth/logout", { refreshToken: b.refreshToken }, bearer(a.accessToken));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("TOKEN_MISMATCH");
  });
});
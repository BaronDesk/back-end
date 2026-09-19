import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { allowAny, requireScope } from "../src/middleware/rbac.middleware";
import { ForbiddenError, UnauthorizedError } from "../src/lib/app-error";
import type { AuthContext, Scope } from "../src/shared/types/auth";

const ctx = (scope: Scope, sub = "user-1", branchId: string | null = null): AuthContext => ({
  sub,
  scope,
  branchId,
  role: "GAMER",
  jti: "jti",
});

const fakeReq = (auth: AuthContext | undefined, extra: Record<string, unknown> = {}) =>
  ({ auth, params: {}, body: undefined, query: {}, ...extra }) as unknown as FastifyRequest;

describe("requireScope — rank", () => {
  it("rejects an unauthenticated request", async () => {
    await expect(requireScope("self")(fakeReq(undefined))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a caller below the minimum scope", async () => {
    await expect(requireScope("staff")(fakeReq(ctx("self")))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireScope("admin")(fakeReq(ctx("staff")))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("accepts equal or higher scopes (hq passes everything)", async () => {
    await expect(requireScope("staff")(fakeReq(ctx("staff")))).resolves.toBeUndefined();
    await expect(requireScope("staff")(fakeReq(ctx("admin")))).resolves.toBeUndefined();
    await expect(requireScope("admin")(fakeReq(ctx("hq")))).resolves.toBeUndefined();
  });
});

describe("requireScope — ownership (self)", () => {
  const gate = requireScope("self", { ownerParam: "id" });

  it("lets a self caller access their own resource", async () => {
    await expect(gate(fakeReq(ctx("self", "abc"), { params: { id: "abc" } }))).resolves.toBeUndefined();
  });

  it("blocks a self caller from someone else's resource", async () => {
    await expect(gate(fakeReq(ctx("self", "abc"), { params: { id: "zzz" } }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it("does not apply the ownership rule to staff or higher", async () => {
    await expect(gate(fakeReq(ctx("staff", "abc"), { params: { id: "zzz" } }))).resolves.toBeUndefined();
    await expect(gate(fakeReq(ctx("hq", "abc"), { params: { id: "zzz" } }))).resolves.toBeUndefined();
  });

  it("supports ownerBody", async () => {
    const bodyGate = requireScope("self", { ownerBody: "userId" });
    await expect(bodyGate(fakeReq(ctx("self", "abc"), { body: { userId: "abc" } }))).resolves.toBeUndefined();
    await expect(bodyGate(fakeReq(ctx("self", "abc"), { body: { userId: "zzz" } }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });
});

describe("requireScope — branch", () => {
  const gate = requireScope("staff", { branchParam: "branchId" });

  it("lets staff act inside their own branch", async () => {
    await expect(gate(fakeReq(ctx("staff", "u", "B1"), { params: { branchId: "B1" } }))).resolves.toBeUndefined();
  });

  it("blocks staff/admin from another branch", async () => {
    await expect(gate(fakeReq(ctx("staff", "u", "B1"), { params: { branchId: "B2" } }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(gate(fakeReq(ctx("admin", "u", "B1"), { params: { branchId: "B2" } }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  it("blocks when the target branch cannot be determined", async () => {
    await expect(gate(fakeReq(ctx("staff", "u", "B1")))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets hq act on any branch", async () => {
    await expect(gate(fakeReq(ctx("hq", "u", null), { params: { branchId: "B2" } }))).resolves.toBeUndefined();
  });

  it("supports an async resolveBranchId", async () => {
    const asyncGate = requireScope("admin", { resolveBranchId: async () => "B1" });
    await expect(asyncGate(fakeReq(ctx("admin", "u", "B1")))).resolves.toBeUndefined();
    await expect(asyncGate(fakeReq(ctx("admin", "u", "B9")))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("allowAny", () => {
  it("allows only the listed scopes (not a rank check)", async () => {
    const gate = allowAny("self", "hq");
    await expect(gate(fakeReq(ctx("self")))).resolves.toBeUndefined();
    await expect(gate(fakeReq(ctx("hq")))).resolves.toBeUndefined();
    await expect(gate(fakeReq(ctx("staff")))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(gate(fakeReq(undefined))).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
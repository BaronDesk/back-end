import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import { UserRole } from "@prisma/client";
import { env } from "../config/env";
import { UnauthorizedError } from "./app-error";
import { AccessTokenClaims, RefreshTokenClaims, ROLE_SCOPE } from "../shared/types/auth";

type JwtNamespace = FastifyInstance["jwt"];

let access: JwtNamespace | null = null;
let refresh: JwtNamespace | null = null;

/**
 * Registers @fastify/jwt twice under separate namespaces so access and refresh
 * tokens are signed with different secrets (a refresh token can never pass as
 * an access token, and vice versa). Must be awaited before the server starts.
 */
export async function registerJwt(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    namespace: "access",
    jwtDecode: "accessJwtDecode",
    jwtSign: "accessJwtSign",
    jwtVerify: "accessJwtVerify",
    decoratorName: "accessUser",
    secret: env.jwt.accessSecret,
    sign: { iss: env.jwt.issuer, expiresIn: env.jwt.accessTtl },
    verify: { allowedIss: env.jwt.issuer },
  });

  await app.register(fastifyJwt, {
    namespace: "refresh",
    jwtDecode: "refreshJwtDecode",
    jwtSign: "refreshJwtSign",
    jwtVerify: "refreshJwtVerify",
    decoratorName: "refreshUser",
    secret: env.jwt.refreshSecret,
    sign: { iss: env.jwt.issuer, expiresIn: env.jwt.refreshTtl },
    verify: { allowedIss: env.jwt.issuer },
  });

  const namespaces = app.jwt as unknown as Record<string, JwtNamespace>;
  access = namespaces.access;
  refresh = namespaces.refresh;
}

function accessJwt(): JwtNamespace {
  if (!access) throw new Error("JWT not initialised — call registerJwt(app) first");
  return access;
}

function refreshJwt(): JwtNamespace {
  if (!refresh) throw new Error("JWT not initialised — call registerJwt(app) first");
  return refresh;
}

interface UserForToken {
  id: string;
  role: UserRole;
  branchId: string | null;
}

// @fastify/jwt's sign(payload, options) does NOT merge `options` with the
// registration-level defaults (sign: { iss, expiresIn }) — it's options ||
// defaults, so passing sub/jti here would otherwise silently drop expiresIn
// and iss, producing a token that never expires. Every call-site must repeat
// them explicitly.

export function signAccessToken(user: UserForToken): { token: string; jti: string } {
  const jti = randomUUID();
  const token = accessJwt().sign(
    {
      role: user.role,
      scope: ROLE_SCOPE[user.role],
      branchId: user.branchId,
    },
    { sub: user.id, jti, expiresIn: env.jwt.accessTtl, iss: env.jwt.issuer }
  );
  return { token, jti };
}

export function signRefreshToken(userId: string, jti = randomUUID()): { token: string; jti: string } {
  const token = refreshJwt().sign(
    {},
    { sub: userId, jti, expiresIn: env.jwt.refreshTtl, iss: env.jwt.issuer }
  );
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return accessJwt().verify(token) as AccessTokenClaims;
  } catch {
    throw new UnauthorizedError("Invalid or expired access token", "INVALID_ACCESS_TOKEN");
  }
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  try {
    return refreshJwt().verify(token) as RefreshTokenClaims;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
  }
}

/** Reads a token's `exp` claim (used to persist expiresAt). Call right after signing. */
export function decodeExpiry(token: string): Date {
  let exp: unknown;
  try {
    exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp;
  } catch {
    exp = undefined;
  }
  if (typeof exp !== "number") {
    throw new Error("Signed token has no exp claim — check JWT_REFRESH_TTL / sign options");
  }
  return new Date(exp * 1000);
}
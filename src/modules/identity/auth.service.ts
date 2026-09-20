import { UserRole } from "@prisma/client";
import * as identityRepo from "./identity.repository";
import { hashPassword, verifyPassword } from "../../lib/password";
import {
  decodeExpiry,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../lib/jwt";
import { UnauthorizedError } from "../../lib/app-error";
import { LoginInput } from "./identity.schemas";

async function branchIdForUser(userId: string): Promise<string | null> {
  const profile = await identityRepo.findEmployeeProfileByUserId(userId);
  return profile?.managedBranchId ?? null;
}

async function issueTokenPair(userId: string, role: import("@prisma/client").UserRole) {
  const branchId = await branchIdForUser(userId);
  const { token: accessToken } = signAccessToken({ id: userId, role, branchId });
  const { token: refreshToken, jti } = signRefreshToken(userId);

  await identityRepo.createRefreshToken({
    jti,
    userId,
    expiresAt: decodeExpiry(refreshToken),
  });

  return { accessToken, refreshToken };
}

export async function login(input: LoginInput) {
  const user = await identityRepo.findUserByUsername(input.username);

  // Constant-shape failure: don't leak whether the username exists.
  if (!user || user.accountStatus !== "ACTIVE") {
    throw new UnauthorizedError("Invalid username or password", "INVALID_CREDENTIALS");
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    throw new UnauthorizedError("Invalid username or password", "INVALID_CREDENTIALS");
  }

  const tokens = await issueTokenPair(user.id, user.role);

  await identityRepo.createAuditLog({ userId: user.id, action: "LOGIN", target: "auth" });

  return {
    ...tokens,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

export async function refresh(refreshToken: string) {
  const claims = verifyRefreshToken(refreshToken);

  const stored = await identityRepo.findRefreshTokenByJti(claims.jti);
  if (!stored || stored.revoked || stored.expiresAt < new Date()) {
    throw new UnauthorizedError("Refresh token is no longer valid", "REFRESH_TOKEN_REVOKED");
  }

  const user = await identityRepo.findUserById(claims.sub);
  if (!user || user.accountStatus !== "ACTIVE") {
    throw new UnauthorizedError("Account is not active", "ACCOUNT_INACTIVE");
  }

  // Rotation: mint a new refresh token, revoke the old one, and link them so
  // a reused/stolen old token is easy to trace.
  const branchId = await branchIdForUser(user.id);
  const { token: accessToken } = signAccessToken({ id: user.id, role: user.role, branchId });
  const { token: newRefreshToken, jti: newJti } = signRefreshToken(user.id);

  await identityRepo.rotateRefreshToken(claims.jti, {
    jti: newJti,
    userId: user.id,
    expiresAt: decodeExpiry(newRefreshToken),
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(userId: string, opts: { jti?: string; refreshToken?: string }) {
  const jti = opts.jti ?? (opts.refreshToken ? verifyRefreshToken(opts.refreshToken).jti : undefined);
  if (!jti) {
    throw new UnauthorizedError("A jti or refreshToken is required to logout", "MISSING_TOKEN_REFERENCE");
  }

  const stored = await identityRepo.findRefreshTokenByJti(jti);
  // Only allow revoking your own session.
  if (!stored || stored.userId !== userId) {
    throw new UnauthorizedError("Token does not belong to the authenticated user", "TOKEN_MISMATCH");
  }

  await identityRepo.revokeRefreshToken(jti);
  await identityRepo.createAuditLog({ userId, action: "LOGOUT", target: "auth" });
}

export async function me(userId: string) {
  const user = await identityRepo.findUserById(userId);
  if (!user) {
    throw new UnauthorizedError("Account no longer exists", "ACCOUNT_NOT_FOUND");
  }
  const branchId = await branchIdForUser(userId);
  return { user: { id: user.id, role: user.role, branchId } };
}

export { hashPassword };

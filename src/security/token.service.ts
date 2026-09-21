import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { JwtService, JwtSignOptions } from "@nestjs/jwt";
import { UserRole } from "../generated/prisma";
import { env } from "../config/env";
import { UnauthorizedError } from "../lib/app-error";
import { AccessTokenClaims, AuthContext, RefreshTokenClaims, ROLE_SCOPE } from "../shared/types/auth";

interface UserForToken {
  id: string;
  role: UserRole;
  branchId: string | null;
}

type Ttl = JwtSignOptions["expiresIn"];

/**
 * Signs and verifies the two JWT kinds. Access and refresh tokens use
 * different secrets, so a refresh token can never pass as an access token (and
 * vice versa). One JwtService serves both — the secret is chosen per call.
 */
@Injectable()
export class TokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  signAccessToken(user: UserForToken): { token: string; jti: string } {
    const jti = randomUUID();
    const token = this.jwt.sign(
      { role: user.role, scope: ROLE_SCOPE[user.role], branchId: user.branchId },
      {
        secret: env.jwt.accessSecret,
        algorithm: "HS256",
        subject: user.id,
        jwtid: jti,
        issuer: env.jwt.issuer,
        expiresIn: env.jwt.accessTtl as Ttl,
      }
    );
    return { token, jti };
  }

  signRefreshToken(userId: string, jti = randomUUID()): { token: string; jti: string } {
    const token = this.jwt.sign(
      {},
      {
        secret: env.jwt.refreshSecret,
        algorithm: "HS256",
        subject: userId,
        jwtid: jti,
        issuer: env.jwt.issuer,
        expiresIn: env.jwt.refreshTtl as Ttl,
      }
    );
    return { token, jti };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      return this.jwt.verify<AccessTokenClaims>(token, {
        secret: env.jwt.accessSecret,
        algorithms: ["HS256"],
        issuer: env.jwt.issuer,
      });
    } catch {
      throw new UnauthorizedError("Invalid or expired access token", "INVALID_ACCESS_TOKEN");
    }
  }

  verifyRefreshToken(token: string): RefreshTokenClaims {
    try {
      return this.jwt.verify<RefreshTokenClaims>(token, {
        secret: env.jwt.refreshSecret,
        algorithms: ["HS256"],
        issuer: env.jwt.issuer,
      });
    } catch {
      throw new UnauthorizedError("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN");
    }
  }

  /** Reads a token's `exp` claim (used to persist expiresAt). Call right after signing. */
  decodeExpiry(token: string): Date {
    const decoded = this.jwt.decode<{ exp?: number } | null>(token);
    if (typeof decoded?.exp !== "number") {
      throw new Error("Signed token has no exp claim — check JWT_REFRESH_TTL / sign options");
    }
    return new Date(decoded.exp * 1000);
  }

  /** Parses `Authorization: Bearer <accessToken>` into an AuthContext, or throws UnauthorizedError. */
  authContextFromHeader(header: string | undefined): AuthContext {
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing bearer token");
    }

    const claims = this.verifyAccessToken(header.slice("Bearer ".length).trim());
    return {
      sub: claims.sub,
      role: claims.role,
      scope: claims.scope,
      branchId: claims.branchId,
      jti: claims.jti,
    };
  }
}

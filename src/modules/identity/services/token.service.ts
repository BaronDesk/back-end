import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AccessTokenPayload, RefreshTokenPayload, StationTokenPayload } from '../../../common/types/jwt-payload.js';
import { ROLE_SCOPE, type Role } from '../../../common/utils/scope.js';

/**
 * Single source of truth for signing/verifying user tokens, for issuing
 * station tokens (enrollment), and for checking the access-key signature of
 * station tokens (StationTokenService owns their claim check). Registered
 * once here and reused everywhere a token must be checked (HTTP guard,
 * dashboard-io handshake) so there is exactly one place that knows the
 * claim shape and the two secrets.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  buildAccessClaims(user: { id: string; role: Role; branchId: string | null }, jti: string): AccessTokenPayload {
    return {
      sub: user.id,
      role: user.role,
      scope: ROLE_SCOPE[user.role],
      branchId: user.branchId,
      jti,
    };
  }

  signAccessToken(claims: AccessTokenPayload): string {
    return this.jwt.sign(claims, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: this.config.getOrThrow('JWT_ACCESS_TTL'),
    });
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    const payload = await this.verifyAccessKeySignature(token);
    // Station tokens share the access key but carry `type: "station"`; user
    // access tokens carry no `type`. A station must never pass as a user.
    if ('type' in payload || typeof payload.role !== 'string' || typeof payload.scope !== 'string') {
      throw new Error('not a user access token');
    }
    return payload as unknown as AccessTokenPayload;
  }

  /**
   * Signature + expiry check against the access key, claims untouched. For
   * other token kinds signed with the same key (station tokens); callers must
   * check the claim shape themselves.
   */
  async verifyAccessKeySignature(token: string): Promise<Record<string, unknown>> {
    return this.jwt.verifyAsync<Record<string, unknown>>(token, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Issued by enrollment once a machine is ENROLLED. Same key as user access
   * tokens; `type: "station"` keeps it from passing verifyAccessToken, and
   * StationTokenService checks these claims on /agent-ws and station REST.
   */
  signStationToken(claims: Omit<StationTokenPayload, 'iat' | 'exp'>): string {
    return this.jwt.sign(claims, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: '365d',
    });
  }

  signRefreshToken(userId: string, jti: string = randomUUID()): { token: string; jti: string } {
    const token = this.jwt.sign(
      { sub: userId, jti } satisfies Omit<RefreshTokenPayload, 'iat' | 'exp'>,
      {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
        expiresIn: this.config.getOrThrow('JWT_REFRESH_TTL'),
      },
    );
    return { token, jti };
  }

  async verifyRefreshToken(token: string): Promise<RefreshTokenPayload> {
    return this.jwt.verifyAsync<RefreshTokenPayload>(token, {
      secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
    });
  }

  refreshTtlToDate(): Date {
    const ttl = this.config.getOrThrow<string>('JWT_REFRESH_TTL');
    return new Date(Date.now() + parseDurationMs(ttl));
  }
}

function parseDurationMs(ttl: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl.trim());
  if (!match) throw new Error(`unsupported duration format: ${ttl}`);

  const value = Number(match[1]);
  const unit = match[2];
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * unitMs[unit];
}

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AccessTokenPayload, RefreshTokenPayload, StationTokenPayload } from '../../../common/types/jwt-payload.js';
import { ROLE_SCOPE, type Role } from '../../../common/utils/scope.js';

/**
 * Single source of truth for signing/verifying both token kinds. Registered
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
    return this.jwt.verifyAsync<AccessTokenPayload>(token, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
    });
  }

  signStationToken(claims: Omit<StationTokenPayload, 'iat' | 'exp'>): string {
    return this.jwt.sign(claims, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: '365d',
    });
  }

  async verifyStationToken(token: string): Promise<StationTokenPayload> {
    const payload = await this.jwt.verifyAsync<StationTokenPayload>(token, {
      secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
    });
    if (payload.type !== 'station' || !payload.sub || !payload.serialNumber || !payload.branchId) {
      throw new Error('invalid station token');
    }
    return payload;
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

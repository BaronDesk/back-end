import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../generated/prisma/index.js';
import { AccessTokenClaims, RefreshTokenClaims, ROLE_SCOPE } from '../common/auth/scope.js';

interface UserForToken { id: string; role: UserRole; branchId: string | null; }

@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtl: string;
  private readonly refreshTtl: string;
  private readonly issuer: string;

  constructor(private readonly jwt: JwtService, config: ConfigService) {
    this.accessSecret = config.getOrThrow('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow('JWT_REFRESH_SECRET');
    this.accessTtl = config.get('JWT_ACCESS_TTL') ?? '15m';
    this.refreshTtl = config.get('JWT_REFRESH_TTL') ?? '7d';
    this.issuer = config.get('JWT_ISSUER') ?? 'cstam-identity';
  }

  signAccessToken(user: UserForToken) {
    const jti = randomUUID();
    const token = this.jwt.sign(
      { role: user.role, scope: ROLE_SCOPE[user.role], branchId: user.branchId },
      { subject: user.id, jwtid: jti, secret: this.accessSecret, expiresIn: this.accessTtl, issuer: this.issuer },
    );
    return { token, jti };
  }

  signRefreshToken(userId: string, jti = randomUUID()) {
    const token = this.jwt.sign({}, { subject: userId, jwtid: jti, secret: this.refreshSecret, expiresIn: this.refreshTtl, issuer: this.issuer });
    return { token, jti };
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try { return this.jwt.verify(token, { secret: this.accessSecret, issuer: this.issuer }); }
    catch { throw new UnauthorizedException('Invalid or expired access token'); }
  }

  verifyRefreshToken(token: string): RefreshTokenClaims {
    try { return this.jwt.verify(token, { secret: this.refreshSecret, issuer: this.issuer }); }
    catch { throw new UnauthorizedException('Invalid or expired refresh token'); }
  }

  decodeExpiry(token: string): Date {
    const { exp } = this.jwt.decode(token) as { exp?: number };
    if (typeof exp !== 'number') throw new Error('Signed token has no exp claim — check JWT_REFRESH_TTL / sign options');
    return new Date(exp * 1000);
  }
}

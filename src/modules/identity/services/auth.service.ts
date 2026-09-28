import { randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { RefreshTokenRepository } from '../repository/refresh-token.repository.js';
import { UsersRepository } from '../repository/users.repository.js';
import type { ChangePasswordDto, LoginDto, LogoutDto, RefreshDto } from '../schemas/auth.schemas.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { toPublicUser } from '../util/public-user.js';

const INVALID_CREDENTIALS = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS', error: 'invalid username or password' });

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.users.findByUsername(dto.username);
    if (!user) throw INVALID_CREDENTIALS();

    const valid = await this.passwords.verify(user.passwordHash, dto.password);
    if (!valid) throw INVALID_CREDENTIALS();

    return this.issueTokenPair(user.id, user.role, user.employeeProfile?.managedBranchId ?? null);
  }

  async refresh(dto: RefreshDto) {
    const payload = await this.verifyRefreshTokenOrThrow(dto.refreshToken);
    const stored = await this.refreshTokens.findByJti(payload.jti);
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', error: 'refresh token is not usable' });
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', error: 'user no longer exists' });

    const pair = await this.issueTokenPair(user.id, user.role, user.employeeProfile?.managedBranchId ?? null);
    await this.refreshTokens.revoke(payload.jti, pair.refreshJti);
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  }

  async logout(dto: LogoutDto): Promise<{ success: true }> {
    const payload = await this.verifyRefreshTokenOrThrow(dto.refreshToken);
    await this.refreshTokens.revoke(payload.jti);
    return { success: true };
  }

  async me(caller: AccessTokenPayload) {
    const user = await this.users.findById(caller.sub);
    if (!user) throw new UnauthorizedException({ code: 'INVALID_TOKEN', error: 'user no longer exists' });
    return toPublicUser(user);
  }

  /**
   * Always operates on the caller's own account (no :id) — nobody, not even
   * hq, can change someone else's password through this route. Revokes every
   * other refresh token afterward, so a stolen session doesn't survive a
   * password change.
   */
  async changePassword(caller: AccessTokenPayload, dto: ChangePasswordDto): Promise<{ success: true }> {
    const user = await this.users.findById(caller.sub);
    if (!user) throw new UnauthorizedException({ code: 'INVALID_TOKEN', error: 'user no longer exists' });

    const valid = await this.passwords.verify(user.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new UnauthorizedException({ code: 'INVALID_CURRENT_PASSWORD', error: 'current password is incorrect' });
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);
    await this.users.updatePasswordHash(caller.sub, passwordHash);
    await this.refreshTokens.revokeAllForUser(caller.sub);

    return { success: true };
  }

  private async verifyRefreshTokenOrThrow(token: string) {
    try {
      return await this.tokens.verifyRefreshToken(token);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', error: 'invalid or expired refresh token' });
    }
  }

  private async issueTokenPair(userId: string, role: AccessTokenPayload['role'], branchId: string | null) {
    const accessJti = randomUUID();
    const claims = this.tokens.buildAccessClaims({ id: userId, role, branchId }, accessJti);
    const accessToken = this.tokens.signAccessToken(claims);

    const { token: refreshToken, jti: refreshJti } = this.tokens.signRefreshToken(userId);
    await this.refreshTokens.create({
      jti: refreshJti,
      userId,
      expiresAt: this.tokens.refreshTtlToDate(),
    });

    return { accessToken, refreshToken, refreshJti };
  }
}

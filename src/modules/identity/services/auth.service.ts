import { randomUUID } from 'node:crypto';

import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { RefreshTokenRepository } from '../repository/refresh-token.repository.js';
import { UsersRepository } from '../repository/users.repository.js';
import type { LoginDto, LogoutDto, RefreshDto } from '../schemas/auth.schemas.js';
import type { ChangePasswordDto } from '../schemas/users.schemas.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { toPublicUser } from '../util/public-user.js';

const INVALID_CREDENTIALS = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS', error: 'invalid username or password' });

/** Suspended (or otherwise not ACTIVE) accounts can't log in, refresh or read /auth/me. */
function assertActive(user: { accountStatus: string }): void {
  if (user.accountStatus !== 'ACTIVE') {
    throw new ForbiddenException({ code: 'ACCOUNT_DISABLED', error: 'this account is disabled' });
  }
}

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
    assertActive(user);

    return this.issueTokenPair(user.id, user.role, user.employeeProfile?.managedBranchId ?? null);
  }

  async refresh(dto: RefreshDto) {
    const payload = await this.verifyRefreshTokenOrThrow(dto.refreshToken);
    const stored = await this.refreshTokens.findByJti(payload.jti);
    if (stored?.revoked && stored.replacedByJti) {
      // Already rotated: someone is replaying an old token. Assume it was
      // stolen and end every session of this user; they log in again.
      await this.refreshTokens.revokeAllForUser(stored.userId);
      throw new UnauthorizedException({ code: 'REFRESH_TOKEN_REUSED', error: 'refresh token was already used' });
    }
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', error: 'refresh token is not usable' });
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException({ code: 'INVALID_REFRESH_TOKEN', error: 'user no longer exists' });
    assertActive(user);

    const pair = await this.issueTokenPair(user.id, user.role, user.employeeProfile?.managedBranchId ?? null);
    await this.refreshTokens.revoke(payload.jti, pair.refreshJti);
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken };
  }

  /**
   * The caller changes their own password. Every other login of theirs ends;
   * this one continues with the fresh token pair returned.
   */
  async changePassword(caller: AccessTokenPayload, dto: ChangePasswordDto) {
    const user = await this.users.findById(caller.sub);
    if (!user) throw new UnauthorizedException({ code: 'INVALID_TOKEN', error: 'user no longer exists' });
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', error: 'current password is wrong' });
    }
    await this.users.setPasswordHash(user.id, await this.passwords.hash(dto.newPassword));
    await this.refreshTokens.revokeAllForUser(user.id);
    const pair = await this.issueTokenPair(user.id, user.role, user.employeeProfile?.managedBranchId ?? null);
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
    assertActive(user);
    return toPublicUser(user);
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

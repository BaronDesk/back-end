import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '../generated/prisma/index.js';
import { IdentityRepository } from '../identity/identity.repository.js';
import { hashPassword, verifyPassword } from '../identity/password.js';
import { TokenService } from './token.service.js';
import { LoginDto } from './dto/login.dto.js';

@Injectable()
export class AuthService {
  constructor(private readonly identity: IdentityRepository, private readonly tokens: TokenService) {}

  private async branchIdForUser(userId: string) {
    return (await this.identity.findEmployeeProfileByUserId(userId))?.managedBranchId ?? null;
  }

  private async issueTokenPair(userId: string, role: UserRole) {
    const branchId = await this.branchIdForUser(userId);
    const { token: accessToken } = this.tokens.signAccessToken({ id: userId, role, branchId });
    const { token: refreshToken, jti } = this.tokens.signRefreshToken(userId);
    await this.identity.createRefreshToken({ jti, userId, expiresAt: this.tokens.decodeExpiry(refreshToken) });
    return { accessToken, refreshToken };
  }

  async login(input: LoginDto) {
    const user = await this.identity.findUserByUsername(input.username);
    if (!user || user.accountStatus !== 'ACTIVE') throw new UnauthorizedException('Invalid username or password');
    if (!(await verifyPassword(user.passwordHash, input.password))) throw new UnauthorizedException('Invalid username or password');

    const tokens = await this.issueTokenPair(user.id, user.role);
    await this.identity.createAuditLog({ userId: user.id, action: 'LOGIN', target: 'auth' });
    return { ...tokens, user: { id: user.id, username: user.username, role: user.role } };
  }

  async refresh(refreshToken: string) {
    const claims = this.tokens.verifyRefreshToken(refreshToken);
    const stored = await this.identity.findRefreshTokenByJti(claims.jti);
    if (!stored || stored.revoked || stored.expiresAt < new Date()) throw new UnauthorizedException('Refresh token is no longer valid');

    const user = await this.identity.findUserById(claims.sub);
    if (!user || user.accountStatus !== 'ACTIVE') throw new UnauthorizedException('Account is not active');

    const branchId = await this.branchIdForUser(user.id);
    const { token: accessToken } = this.tokens.signAccessToken({ id: user.id, role: user.role, branchId });
    const { token: newRefreshToken, jti: newJti } = this.tokens.signRefreshToken(user.id);
    await this.identity.rotateRefreshToken(claims.jti, { jti: newJti, userId: user.id, expiresAt: this.tokens.decodeExpiry(newRefreshToken) });
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(userId: string, opts: { jti?: string; refreshToken?: string }) {
    const jti = opts.jti ?? (opts.refreshToken ? this.tokens.verifyRefreshToken(opts.refreshToken).jti : undefined);
    if (!jti) throw new UnauthorizedException('A jti or refreshToken is required to logout');
    const stored = await this.identity.findRefreshTokenByJti(jti);
    if (!stored || stored.userId !== userId) throw new UnauthorizedException('Token does not belong to the authenticated user');
    await this.identity.revokeRefreshToken(jti);
    await this.identity.createAuditLog({ userId, action: 'LOGOUT', target: 'auth' });
  }

  async me(userId: string) {
    const user = await this.identity.findUserById(userId);
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return { user: { id: user.id, role: user.role, branchId: await this.branchIdForUser(userId) } };
  }
}

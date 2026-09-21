import { Inject, Injectable } from "@nestjs/common";
import { UserRole } from "../../generated/prisma";
import { IdentityRepository } from "./identity.repository";
import { verifyPassword } from "../../lib/password";
import { UnauthorizedError } from "../../lib/app-error";
import { TokenService } from "../../security/token.service";
import { LoginInput } from "./identity.schemas";

@Injectable()
export class AuthService {
  constructor(
    @Inject(IdentityRepository) private readonly repo: IdentityRepository,
    @Inject(TokenService) private readonly tokens: TokenService
  ) {}

  async login(input: LoginInput) {
    const user = await this.repo.findUserByUsername(input.username);

    // Constant-shape failure: don't leak whether the username exists.
    if (!user || user.accountStatus !== "ACTIVE") {
      throw new UnauthorizedError("Invalid username or password", "INVALID_CREDENTIALS");
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      throw new UnauthorizedError("Invalid username or password", "INVALID_CREDENTIALS");
    }

    const tokens = await this.issueTokenPair(user.id, user.role);

    await this.repo.createAuditLog({ userId: user.id, action: "LOGIN", target: "auth" });

    return {
      ...tokens,
      user: { id: user.id, username: user.username, role: user.role },
    };
  }

  async refresh(refreshToken: string) {
    const claims = this.tokens.verifyRefreshToken(refreshToken);

    const stored = await this.repo.findRefreshTokenByJti(claims.jti);
    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedError("Refresh token is no longer valid", "REFRESH_TOKEN_REVOKED");
    }

    const user = await this.repo.findUserById(claims.sub);
    if (!user || user.accountStatus !== "ACTIVE") {
      throw new UnauthorizedError("Account is not active", "ACCOUNT_INACTIVE");
    }

    // Rotation: mint a new refresh token, revoke the old one, and link them so
    // a reused/stolen old token is easy to trace.
    const branchId = await this.branchIdForUser(user.id);
    const { token: accessToken } = this.tokens.signAccessToken({ id: user.id, role: user.role, branchId });
    const { token: newRefreshToken, jti: newJti } = this.tokens.signRefreshToken(user.id);

    await this.repo.rotateRefreshToken(claims.jti, {
      jti: newJti,
      userId: user.id,
      expiresAt: this.tokens.decodeExpiry(newRefreshToken),
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(userId: string, opts: { jti?: string; refreshToken?: string }) {
    const jti =
      opts.jti ?? (opts.refreshToken ? this.tokens.verifyRefreshToken(opts.refreshToken).jti : undefined);
    if (!jti) {
      throw new UnauthorizedError("A jti or refreshToken is required to logout", "MISSING_TOKEN_REFERENCE");
    }

    const stored = await this.repo.findRefreshTokenByJti(jti);
    // Only allow revoking your own session.
    if (!stored || stored.userId !== userId) {
      throw new UnauthorizedError("Token does not belong to the authenticated user", "TOKEN_MISMATCH");
    }

    await this.repo.revokeRefreshToken(jti);
    await this.repo.createAuditLog({ userId, action: "LOGOUT", target: "auth" });
  }

  async me(userId: string) {
    const user = await this.repo.findUserById(userId);
    if (!user) {
      throw new UnauthorizedError("Account no longer exists", "ACCOUNT_NOT_FOUND");
    }
    const branchId = await this.branchIdForUser(userId);
    return { user: { id: user.id, role: user.role, branchId } };
  }

  private async branchIdForUser(userId: string): Promise<string | null> {
    const profile = await this.repo.findEmployeeProfileByUserId(userId);
    return profile?.managedBranchId ?? null;
  }

  private async issueTokenPair(userId: string, role: UserRole) {
    const branchId = await this.branchIdForUser(userId);
    const { token: accessToken } = this.tokens.signAccessToken({ id: userId, role, branchId });
    const { token: refreshToken, jti } = this.tokens.signRefreshToken(userId);

    await this.repo.createRefreshToken({
      jti,
      userId,
      expiresAt: this.tokens.decodeExpiry(refreshToken),
    });

    return { accessToken, refreshToken };
  }
}

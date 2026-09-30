import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

describe('AuthService', () => {
  let users: Record<string, ReturnType<typeof vi.fn>>;
  let refreshTokens: Record<string, ReturnType<typeof vi.fn>>;
  let passwords: { verify: ReturnType<typeof vi.fn> };
  let tokens: Record<string, ReturnType<typeof vi.fn>>;
  let service: AuthService;

  const user = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1', username: 'ali', role: 'GAMER', accountStatus: 'ACTIVE', passwordHash: 'h', createdAt: new Date(),
    employeeProfile: null, ...overrides,
  });
  const stored = (overrides: Record<string, unknown> = {}) => ({
    jti: 'r1', userId: 'u1', revoked: false, replacedByJti: null, expiresAt: new Date(Date.now() + 60_000), ...overrides,
  });

  beforeEach(() => {
    users = {
      findByUsername: vi.fn(async () => user()),
      findById: vi.fn(async () => user()),
      setPasswordHash: vi.fn(async () => user()),
    };
    refreshTokens = {
      create: vi.fn(async () => ({})),
      findByJti: vi.fn(async () => stored()),
      revoke: vi.fn(async () => ({})),
      revokeAllForUser: vi.fn(async () => ({ count: 3 })),
    };
    passwords = { verify: vi.fn(async () => true), hash: vi.fn(async () => 'new-hash') } as any;
    tokens = {
      buildAccessClaims: vi.fn(() => ({})),
      signAccessToken: vi.fn(() => 'access'),
      signRefreshToken: vi.fn(() => ({ token: 'refresh', jti: 'r2' })),
      refreshTtlToDate: vi.fn(() => new Date()),
      verifyRefreshToken: vi.fn(async () => ({ sub: 'u1', jti: 'r1' })),
    };
    service = new AuthService(users as any, refreshTokens as any, passwords as any, tokens as any);
  });

  it('logs an active user in', async () => {
    await expect(service.login({ username: 'ali', password: 'secret123' })).resolves.toMatchObject({ accessToken: 'access' });
  });

  it('refuses a suspended account at login, refresh and /auth/me', async () => {
    users.findByUsername.mockResolvedValue(user({ accountStatus: 'SUSPENDED' }));
    users.findById.mockResolvedValue(user({ accountStatus: 'SUSPENDED' }));
    await expect(service.login({ username: 'ali', password: 'secret123' })).rejects.toMatchObject({ response: { code: 'ACCOUNT_DISABLED' } });
    await expect(service.refresh({ refreshToken: 'refresh-token' })).rejects.toMatchObject({ response: { code: 'ACCOUNT_DISABLED' } });
    await expect(service.me({ sub: 'u1' } as any)).rejects.toMatchObject({ response: { code: 'ACCOUNT_DISABLED' } });
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('treats a replayed (already rotated) refresh token as stolen: every login of the user ends', async () => {
    refreshTokens.findByJti.mockResolvedValue(stored({ revoked: true, replacedByJti: 'r2' }));
    await expect(service.refresh({ refreshToken: 'refresh-token' })).rejects.toMatchObject({ response: { code: 'REFRESH_TOKEN_REUSED' } });
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u1');
  });

  it('refuses a logged-out token without revoking the rest', async () => {
    refreshTokens.findByJti.mockResolvedValue(stored({ revoked: true }));
    await expect(service.refresh({ refreshToken: 'refresh-token' })).rejects.toMatchObject({ response: { code: 'INVALID_REFRESH_TOKEN' } });
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('changes the own password with the current one, ends other logins and keeps this one going', async () => {
    await expect(service.changePassword({ sub: 'u1' } as any, { currentPassword: 'old', newPassword: 'new-secret-1' })).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(users.setPasswordHash).toHaveBeenCalledWith('u1', 'new-hash');
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u1');

    passwords.verify.mockResolvedValueOnce(false);
    await expect(service.changePassword({ sub: 'u1' } as any, { currentPassword: 'bad', newPassword: 'new-secret-1' })).rejects.toMatchObject({
      response: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it('rotates a valid refresh token', async () => {
    await expect(service.refresh({ refreshToken: 'refresh-token' })).resolves.toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    expect(refreshTokens.revoke).toHaveBeenCalledWith('r1', 'r2');
  });
});

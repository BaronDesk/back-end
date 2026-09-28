import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { AuthService } from './auth.service.js';

// Only changePassword is covered here — login/refresh/logout are exercised
// end-to-end in test/auth.e2e-spec.ts against a real database.
describe('AuthService.changePassword', () => {
  let users: { findById: ReturnType<typeof vi.fn>; updatePasswordHash: ReturnType<typeof vi.fn> };
  let refreshTokens: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let passwords: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let service: AuthService;

  const caller: AccessTokenPayload = {
    sub: 'user-1',
    role: 'GAMER',
    scope: 'self',
    branchId: null,
    jti: 'jti-1',
  };

  beforeEach(() => {
    users = {
      findById: vi.fn().mockResolvedValue({ id: 'user-1', passwordHash: 'old-hash' }),
      updatePasswordHash: vi.fn().mockResolvedValue(undefined),
    };
    refreshTokens = { revokeAllForUser: vi.fn().mockResolvedValue(undefined) };
    passwords = {
      hash: vi.fn().mockResolvedValue('new-hash'),
      verify: vi.fn(),
    };
    service = new AuthService(users as any, refreshTokens as any, passwords as any, {} as any);
  });

  it('rejects an incorrect current password without touching the stored hash', async () => {
    passwords.verify.mockResolvedValue(false);

    await expect(
      service.changePassword(caller, { currentPassword: 'wrong', newPassword: 'new-password-1' }),
    ).rejects.toThrow(UnauthorizedException);

    expect(users.updatePasswordHash).not.toHaveBeenCalled();
    expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('hashes and stores the new password, then revokes every other session', async () => {
    passwords.verify.mockResolvedValue(true);

    const result = await service.changePassword(caller, {
      currentPassword: 'correct',
      newPassword: 'new-password-1',
    });

    expect(passwords.verify).toHaveBeenCalledWith('old-hash', 'correct');
    expect(passwords.hash).toHaveBeenCalledWith('new-password-1');
    expect(users.updatePasswordHash).toHaveBeenCalledWith('user-1', 'new-hash');
    expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ success: true });
  });

  it('rejects if the account no longer exists', async () => {
    users.findById.mockResolvedValue(null);

    await expect(
      service.changePassword(caller, { currentPassword: 'x', newPassword: 'new-password-1' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});

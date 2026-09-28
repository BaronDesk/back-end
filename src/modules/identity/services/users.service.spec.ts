import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { UsersService } from './users.service.js';

function caller(overrides: Partial<AccessTokenPayload>): AccessTokenPayload {
  return {
    sub: 'caller-id',
    role: 'MANAGER',
    scope: 'admin',
    branchId: 'branch-a',
    jti: 'jti-1',
    ...overrides,
  };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'target-1',
    username: 'someone',
    role: 'EMPLOYEE',
    accountStatus: 'ACTIVE',
    createdAt: new Date(),
    employeeProfile: { managedBranchId: 'branch-a', employmentStatus: 'ACTIVE' },
    ...overrides,
  };
}

describe('UsersService', () => {
  let repo: {
    createGamer: ReturnType<typeof vi.fn>;
    createEmployee: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    updateRole: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    updateAccountStatus: ReturnType<typeof vi.fn>;
    updateEmploymentStatus: ReturnType<typeof vi.fn>;
  };
  let passwords: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let service: UsersService;

  beforeEach(() => {
    repo = {
      createGamer: vi.fn().mockResolvedValue({ id: 'u1', username: 'gamer1', role: 'GAMER', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: null }),
      createEmployee: vi.fn().mockResolvedValue({ id: 'u2', username: 'emp1', role: 'EMPLOYEE', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: { managedBranchId: 'branch-a' } }),
      findById: vi.fn(),
      updateRole: vi.fn(),
      list: vi.fn(),
      updateAccountStatus: vi.fn(),
      updateEmploymentStatus: vi.fn(),
    };
    passwords = {
      hash: vi.fn().mockResolvedValue('hashed-password'),
      verify: vi.fn(),
    };
    service = new UsersService(repo as any, passwords as any);
  });

  it('hashes the password and delegates gamer creation to the repository', async () => {
    const result = await service.createGamer({ username: 'gamer1', password: 'plaintext' });

    expect(passwords.hash).toHaveBeenCalledWith('plaintext');
    expect(repo.createGamer).toHaveBeenCalledWith({ username: 'gamer1', passwordHash: 'hashed-password' });
    expect(result).toMatchObject({ id: 'u1', role: 'GAMER' });
  });

  it('lets a MANAGER create an EMPLOYEE in their own branch', async () => {
    const result = await service.createEmployee(caller({}), {
      username: 'emp1',
      password: 'plaintext',
      role: 'EMPLOYEE',
      branchId: 'branch-a',
    });

    expect(repo.createEmployee).toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'u2', role: 'EMPLOYEE' });
  });

  it('blocks a MANAGER from creating a MANAGER', async () => {
    await expect(
      service.createEmployee(caller({}), {
        username: 'emp2',
        password: 'plaintext',
        role: 'MANAGER',
        branchId: 'branch-a',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.createEmployee).not.toHaveBeenCalled();
  });

  it('blocks a MANAGER from creating an EMPLOYEE in another branch', async () => {
    await expect(
      service.createEmployee(caller({ branchId: 'branch-a' }), {
        username: 'emp3',
        password: 'plaintext',
        role: 'EMPLOYEE',
        branchId: 'branch-b',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.createEmployee).not.toHaveBeenCalled();
  });

  it('lets an hq ADMIN create a MANAGER in any branch', async () => {
    repo.createEmployee.mockResolvedValueOnce({
      id: 'u3',
      username: 'mgr1',
      role: 'MANAGER',
      accountStatus: 'ACTIVE',
      createdAt: new Date(),
      employeeProfile: { managedBranchId: 'branch-z' },
    });

    const result = await service.createEmployee(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), {
      username: 'mgr1',
      password: 'plaintext',
      role: 'MANAGER',
      branchId: 'branch-z',
    });

    expect(result).toMatchObject({ id: 'u3', role: 'MANAGER' });
  });

  describe('list', () => {
    it("scopes to the caller's own branch for staff/admin", async () => {
      repo.list.mockResolvedValue([]);
      await service.list(caller({}), {});
      expect(repo.list).toHaveBeenCalledWith({ role: undefined, accountStatus: undefined, branchId: 'branch-a' });
    });

    it('lets hq filter by any branch, or see everything with none given', async () => {
      repo.list.mockResolvedValue([]);
      await service.list(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), { branchId: 'branch-z' });
      expect(repo.list).toHaveBeenCalledWith({ role: undefined, accountStatus: undefined, branchId: 'branch-z' });
    });

    it('blocks staff/admin from explicitly requesting another branch', async () => {
      await expect(service.list(caller({}), { branchId: 'branch-b' })).rejects.toThrow(ForbiddenException);
      expect(repo.list).not.toHaveBeenCalled();
    });
  });

  describe('updateAccountStatus', () => {
    it('404s for a missing user', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.updateAccountStatus(caller({}), 'missing', { accountStatus: 'SUSPENDED' })).rejects.toThrow(
        'user not found',
      );
    });

    it('lets a MANAGER suspend an EMPLOYEE in their own branch', async () => {
      repo.findById.mockResolvedValue(user());
      repo.updateAccountStatus.mockResolvedValue(user({ accountStatus: 'SUSPENDED' }));

      const result = await service.updateAccountStatus(caller({}), 'target-1', { accountStatus: 'SUSPENDED' });
      expect(repo.updateAccountStatus).toHaveBeenCalledWith('target-1', 'SUSPENDED');
      expect(result.accountStatus).toBe('SUSPENDED');
    });

    it('blocks a MANAGER from suspending a GAMER (no branch to scope to)', async () => {
      repo.findById.mockResolvedValue(user({ role: 'GAMER', employeeProfile: null }));
      await expect(
        service.updateAccountStatus(caller({}), 'target-1', { accountStatus: 'SUSPENDED' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks a MANAGER from suspending another MANAGER', async () => {
      repo.findById.mockResolvedValue(user({ role: 'MANAGER' }));
      await expect(
        service.updateAccountStatus(caller({}), 'target-1', { accountStatus: 'SUSPENDED' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks a MANAGER from acting on an employee in another branch', async () => {
      repo.findById.mockResolvedValue(user({ employeeProfile: { managedBranchId: 'branch-b', employmentStatus: 'ACTIVE' } }));
      await expect(
        service.updateAccountStatus(caller({}), 'target-1', { accountStatus: 'SUSPENDED' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks anyone from changing their own account status via this route', async () => {
      repo.findById.mockResolvedValue(user({ id: 'caller-id' }));
      await expect(
        service.updateAccountStatus(caller({}), 'caller-id', { accountStatus: 'SUSPENDED' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets hq suspend a GAMER account', async () => {
      repo.findById.mockResolvedValue(user({ role: 'GAMER', employeeProfile: null }));
      repo.updateAccountStatus.mockResolvedValue(user({ role: 'GAMER', employeeProfile: null, accountStatus: 'SUSPENDED' }));

      const result = await service.updateAccountStatus(
        caller({ scope: 'hq', role: 'ADMIN', branchId: null }),
        'target-1',
        { accountStatus: 'SUSPENDED' },
      );
      expect(result.accountStatus).toBe('SUSPENDED');
    });
  });

  describe('updateEmploymentStatus', () => {
    it('refuses a target with no employee profile, even for hq', async () => {
      repo.findById.mockResolvedValue(user({ role: 'GAMER', employeeProfile: null }));
      await expect(
        service.updateEmploymentStatus(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), 'target-1', {
          employmentStatus: 'TERMINATED',
        }),
      ).rejects.toThrow('user has no employee profile');
    });

    it('lets a MANAGER set employment status for their own branch', async () => {
      repo.findById.mockResolvedValue(user());
      repo.updateEmploymentStatus.mockResolvedValue(user({ employeeProfile: { managedBranchId: 'branch-a', employmentStatus: 'ON_LEAVE' } }));

      const result = await service.updateEmploymentStatus(caller({}), 'target-1', { employmentStatus: 'ON_LEAVE' });
      expect(repo.updateEmploymentStatus).toHaveBeenCalledWith('target-1', 'ON_LEAVE');
      expect(result.employmentStatus).toBe('ON_LEAVE');
    });

    it('blocks cross-branch employment-status changes', async () => {
      repo.findById.mockResolvedValue(user({ employeeProfile: { managedBranchId: 'branch-b', employmentStatus: 'ACTIVE' } }));
      await expect(
        service.updateEmploymentStatus(caller({}), 'target-1', { employmentStatus: 'TERMINATED' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

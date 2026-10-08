import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
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

describe('UsersService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let passwords: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let refreshTokens: { revokeAllForUser: ReturnType<typeof vi.fn> };
  let service: UsersService;

  const user = (overrides: Record<string, unknown> = {}) => ({
    id: 'target', username: 't', role: 'EMPLOYEE', accountStatus: 'ACTIVE', createdAt: new Date(),
    employeeProfile: { managedBranchId: 'branch-a' }, ...overrides,
  });

  beforeEach(() => {
    repo = {
      createGamer: vi.fn().mockResolvedValue({ id: 'u1', username: 'gamer1', role: 'GAMER', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: null }),
      createEmployee: vi.fn().mockResolvedValue({ id: 'u2', username: 'emp1', role: 'EMPLOYEE', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: { managedBranchId: 'branch-a' } }),
      findById: vi.fn(),
      updateRole: vi.fn(async (id, role) => user({ id, role })),
      setStatus: vi.fn(async (id, accountStatus) => user({ id, accountStatus })),
      setPasswordHash: vi.fn(async (id) => user({ id })),
      setHomeBranch: vi.fn(async (id, homeBranchId) => user({ id, role: 'GAMER', employeeProfile: null, gamerProfile: { id: 'gp', homeBranchId } })),
      branchExists: vi.fn(async () => true),
      list: vi.fn(async () => [user()]),
    };
    passwords = {
      hash: vi.fn().mockResolvedValue('hashed-password'),
      verify: vi.fn(),
    };
    refreshTokens = { revokeAllForUser: vi.fn(async () => ({ count: 2 })) };
    service = new UsersService(repo as any, passwords as any, refreshTokens as any, { record: vi.fn() } as any, { release: vi.fn(), save: vi.fn() } as any);
  });

  describe('role changes', () => {
    it('never lets a manager touch a MANAGER or ADMIN, or their own role', async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'ADMIN', employeeProfile: null }));
      await expect(service.updateRole(caller({}), 'target', { role: 'EMPLOYEE', branchId: 'branch-a' })).rejects.toMatchObject({
        response: { code: 'FORBIDDEN_ROLE_ESCALATION' },
      });
      repo.findById.mockResolvedValueOnce(user({ role: 'MANAGER' }));
      await expect(service.updateRole(caller({}), 'target', { role: 'GAMER' })).rejects.toThrow(ForbiddenException);
      repo.findById.mockResolvedValueOnce(user({ id: 'caller-id', role: 'MANAGER' }));
      await expect(service.updateRole(caller({}), 'caller-id', { role: 'EMPLOYEE' })).rejects.toThrow(ForbiddenException);
      expect(repo.updateRole).not.toHaveBeenCalled();
    });

    it('lets a manager turn a gamer into an employee of their branch, and HQ change a manager', async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'GAMER', employeeProfile: null }));
      await expect(service.updateRole(caller({}), 'target', { role: 'EMPLOYEE', branchId: 'branch-a' })).resolves.toMatchObject({ role: 'EMPLOYEE' });
      repo.findById.mockResolvedValueOnce(user({ role: 'MANAGER' }));
      await expect(
        service.updateRole(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), 'target', { role: 'EMPLOYEE' }),
      ).resolves.toMatchObject({ role: 'EMPLOYEE' });
    });
  });

  describe('account status', () => {
    it('suspends an employee of the manager’s branch and ends their logins', async () => {
      repo.findById.mockResolvedValueOnce(user());
      await expect(service.setStatus(caller({}), 'target', 'SUSPENDED')).resolves.toMatchObject({ accountStatus: 'SUSPENDED' });
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('target');
    });

    it('keeps managers to their own branch’s employees, and nobody can suspend themselves', async () => {
      repo.findById.mockResolvedValueOnce(user({ employeeProfile: { managedBranchId: 'branch-b' } }));
      await expect(service.setStatus(caller({}), 'target', 'SUSPENDED')).rejects.toThrow(ForbiddenException);
      repo.findById.mockResolvedValueOnce(user({ role: 'GAMER', employeeProfile: null }));
      await expect(service.setStatus(caller({}), 'target', 'SUSPENDED')).rejects.toThrow(ForbiddenException);
      repo.findById.mockResolvedValueOnce(user({ id: 'caller-id' }));
      await expect(service.setStatus(caller({ scope: 'hq', role: 'ADMIN' }), 'caller-id', 'SUSPENDED')).rejects.toThrow(ForbiddenException);
      expect(repo.setStatus).not.toHaveBeenCalled();
    });

    it('reactivating does not revoke anything', async () => {
      repo.findById.mockResolvedValueOnce(user({ accountStatus: 'SUSPENDED' }));
      await service.setStatus(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), 'target', 'ACTIVE');
      expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  it('answers a taken username with 409 USERNAME_TAKEN', async () => {
    repo.createGamer.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 't' }));
    await expect(service.createGamer({ username: 'gamer1', password: 'plaintext', branchId: 'branch-a' })).rejects.toMatchObject({
      response: { code: 'USERNAME_TAKEN' },
    });
  });

  describe('home branch', () => {
    it('refuses to sign up to a branch that does not exist', async () => {
      repo.branchExists.mockResolvedValueOnce(false);
      await expect(service.createGamer({ username: 'g', password: 'plaintext', branchId: 'nope' })).rejects.toMatchObject({
        response: { code: 'BRANCH_NOT_FOUND' },
      });
      expect(repo.createGamer).not.toHaveBeenCalled();
    });

    it('lets a gamer change their branch, and nobody without a gamer profile', async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'GAMER', employeeProfile: null, gamerProfile: { id: 'gp', homeBranchId: 'branch-a' } }));
      await expect(service.setHomeBranch(caller({ scope: 'self', role: 'GAMER' }), 'branch-b')).resolves.toMatchObject({ homeBranchId: 'branch-b' });
      repo.findById.mockResolvedValueOnce(user());
      await expect(service.setHomeBranch(caller({}), 'branch-b')).rejects.toMatchObject({ response: { code: 'NOT_A_GAMER' } });
    });
  });

  describe('lists and passwords', () => {
    it('lists everyone for HQ, and gamers plus their own staff for a branch', async () => {
      await service.list(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), { limit: 50 });
      expect(repo.list).toHaveBeenLastCalledWith(expect.objectContaining({ visibleBranchId: null }));
      await service.list(caller({}), { limit: 50, q: 'ali' });
      expect(repo.list).toHaveBeenLastCalledWith(expect.objectContaining({ visibleBranchId: 'branch-a', q: 'ali' }));
    });

    it('finds gamers by username for the desk', async () => {
      await service.searchGamers('ali');
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'ali', role: 'GAMER' }));
    });

    it("lets a manager reset their branch's employees and gamers, and ends the user's logins", async () => {
      repo.findById.mockResolvedValueOnce(user({ role: 'GAMER', employeeProfile: null, gamerProfile: { id: 'gp', homeBranchId: 'branch-a' } }));
      await expect(service.resetPassword(caller({}), 'target', 'new-secret-1')).resolves.toEqual({ id: 'target', reset: true });
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('target');

      repo.findById.mockResolvedValueOnce(user({ role: 'GAMER', employeeProfile: null, gamerProfile: { id: 'gp', homeBranchId: 'branch-b' } }));
      await expect(service.resetPassword(caller({}), 'target', 'new-secret-1')).rejects.toThrow(ForbiddenException);
      repo.findById.mockResolvedValueOnce(user({ role: 'MANAGER' }));
      await expect(service.resetPassword(caller({}), 'target', 'new-secret-1')).rejects.toThrow(ForbiddenException);
    });
  });

  it('hashes the password and delegates gamer creation to the repository', async () => {
    const result = await service.createGamer({ username: 'gamer1', password: 'plaintext', branchId: 'branch-a' });

    expect(passwords.hash).toHaveBeenCalledWith('plaintext');
    expect(repo.createGamer).toHaveBeenCalledWith({ username: 'gamer1', passwordHash: 'hashed-password', homeBranchId: 'branch-a' });
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
});

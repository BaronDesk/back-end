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

describe('UsersService', () => {
  let repo: { createGamer: ReturnType<typeof vi.fn>; createEmployee: ReturnType<typeof vi.fn>; findById: ReturnType<typeof vi.fn>; updateRole: ReturnType<typeof vi.fn> };
  let passwords: { hash: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  let service: UsersService;

  beforeEach(() => {
    repo = {
      createGamer: vi.fn().mockResolvedValue({ id: 'u1', username: 'gamer1', role: 'GAMER', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: null }),
      createEmployee: vi.fn().mockResolvedValue({ id: 'u2', username: 'emp1', role: 'EMPLOYEE', accountStatus: 'ACTIVE', createdAt: new Date(), employeeProfile: { managedBranchId: 'branch-a' } }),
      findById: vi.fn(),
      updateRole: vi.fn(),
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
});

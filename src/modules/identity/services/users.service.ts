import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { UserRole } from '../../../generated/prisma/index.js';
import { UsersRepository } from '../repository/users.repository.js';
import type { CreateEmployeeDto, CreateGamerDto, UpdateRoleDto } from '../schemas/users.schemas.js';
import { toPublicUser } from '../util/public-user.js';
import { PasswordService } from './password.service.js';

const ELEVATED_ROLES: readonly UserRole[] = ['MANAGER', 'ADMIN'];

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly passwords: PasswordService,
  ) {}

  async createGamer(dto: CreateGamerDto) {
    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.usersRepo.createGamer({ username: dto.username, passwordHash });
    return toPublicUser(user);
  }

  async createEmployee(caller: AccessTokenPayload, dto: CreateEmployeeDto) {
    this.assertCanAssignRole(caller, { newRole: dto.role, newBranchId: dto.branchId, currentBranchId: null });

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.usersRepo.createEmployee({
      username: dto.username,
      passwordHash,
      role: dto.role,
      branchId: dto.branchId,
    });
    return toPublicUser(user);
  }

  async updateRole(caller: AccessTokenPayload, targetId: string, dto: UpdateRoleDto) {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });

    this.assertCanAssignRole(caller, {
      newRole: dto.role,
      newBranchId: dto.branchId,
      currentBranchId: target.employeeProfile?.managedBranchId ?? null,
    });

    const user = await this.usersRepo.updateRole(targetId, dto.role, dto.branchId);
    return toPublicUser(user);
  }

  async getUser(caller: AccessTokenPayload, id: string) {
    const user = await this.usersRepo.findById(id);
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });

    assertScope(caller, { userId: user.id, branchId: user.employeeProfile?.managedBranchId ?? null });
    return toPublicUser(user);
  }

  /**
   * MANAGER (admin scope) may only create/promote to EMPLOYEE, and only
   * within their own branch. ADMIN (hq scope) bypasses both restrictions.
   */
  private assertCanAssignRole(
    caller: AccessTokenPayload,
    target: { newRole: UserRole; newBranchId?: string | null; currentBranchId: string | null },
  ): void {
    if (caller.scope === 'hq') return;

    if (ELEVATED_ROLES.includes(target.newRole)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE_ESCALATION',
        error: 'cannot assign MANAGER or ADMIN role',
      });
    }

    if (target.newBranchId != null && target.newBranchId !== caller.branchId) {
      throw new ForbiddenException({ code: 'FORBIDDEN_CROSS_BRANCH', error: 'cross-branch access denied' });
    }

    if (target.currentBranchId != null && target.currentBranchId !== caller.branchId) {
      throw new ForbiddenException({ code: 'FORBIDDEN_CROSS_BRANCH', error: 'cross-branch access denied' });
    }
  }
}

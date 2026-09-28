import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { UserRole } from '../../../generated/prisma/index.js';
import { UsersRepository } from '../repository/users.repository.js';
import type {
  CreateEmployeeDto,
  CreateGamerDto,
  ListUsersQueryDto,
  UpdateAccountStatusDto,
  UpdateEmploymentStatusDto,
  UpdateRoleDto,
} from '../schemas/users.schemas.js';
import { toPublicUser, type UserWithEmployeeProfile } from '../util/public-user.js';
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
   * staff(branch): a non-hq caller is always scoped to their own branch —
   * an explicit `branchId` in the query is only honored if it matches
   * their own (assertScope rejects anything else). hq with no branchId
   * filter sees every branch.
   */
  async list(caller: AccessTokenPayload, query: ListUsersQueryDto) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });

    const branchId = caller.scope === 'hq' ? query.branchId : (caller.branchId ?? undefined);
    const users = await this.usersRepo.list({ role: query.role, accountStatus: query.accountStatus, branchId });
    return users.map(toPublicUser);
  }

  /**
   * admin(branch): flips a user's accountStatus (the "soft delete" — suspend,
   * deactivate, or mark deleted — rows are never hard-deleted). Only hq can
   * touch a GAMER (they belong to no branch) or a MANAGER/ADMIN account, and
   * nobody can touch their own via this route.
   */
  async updateAccountStatus(caller: AccessTokenPayload, targetId: string, dto: UpdateAccountStatusDto) {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });

    this.assertCanManagePeer(caller, target);

    const user = await this.usersRepo.updateAccountStatus(targetId, dto.accountStatus);
    return toPublicUser(user);
  }

  /** admin(branch): same rules as updateAccountStatus, but only valid for a user with an employee profile. */
  async updateEmploymentStatus(caller: AccessTokenPayload, targetId: string, dto: UpdateEmploymentStatusDto) {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });
    if (!target.employeeProfile) {
      throw new ConflictException({ code: 'NOT_AN_EMPLOYEE', error: 'user has no employee profile' });
    }

    this.assertCanManagePeer(caller, target);

    const user = await this.usersRepo.updateEmploymentStatus(targetId, dto.employmentStatus);
    return toPublicUser(user);
  }

  /**
   * Shared guard for updateAccountStatus/updateEmploymentStatus: hq can
   * manage anyone; a branch MANAGER can only manage EMPLOYEE accounts in
   * their own branch, never a peer/superior (MANAGER/ADMIN), a GAMER (no
   * branch to scope to), or themselves.
   */
  private assertCanManagePeer(caller: AccessTokenPayload, target: UserWithEmployeeProfile): void {
    if (caller.scope === 'hq') return;

    if (target.id === caller.sub) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_SELF_MANAGEMENT',
        error: 'cannot change your own account/employment status here',
      });
    }

    if (!target.employeeProfile || ELEVATED_ROLES.includes(target.role as UserRole)) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ROLE_ESCALATION', error: 'cannot manage this account' });
    }

    if (target.employeeProfile.managedBranchId !== caller.branchId) {
      throw new ForbiddenException({ code: 'FORBIDDEN_CROSS_BRANCH', error: 'cross-branch access denied' });
    }
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

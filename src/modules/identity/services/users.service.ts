import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma, type UserRole } from '../../../generated/prisma/index.js';
import { RefreshTokenRepository } from '../repository/refresh-token.repository.js';
import { UsersRepository } from '../repository/users.repository.js';
import type { CreateEmployeeDto, CreateGamerDto, ListUsersQuery, UpdateRoleDto } from '../schemas/users.schemas.js';
import { toPublicUser } from '../util/public-user.js';
import { PasswordService } from './password.service.js';

const ELEVATED_ROLES: readonly UserRole[] = ['MANAGER', 'ADMIN'];

/** A unique-username violation becomes 409 USERNAME_TAKEN; anything else is rethrown. */
function usernameTaken(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictException({ code: 'USERNAME_TAKEN', error: 'this username is already taken' });
  }
  throw err;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  /** Sign-up: every gamer picks the branch they play at. */
  async createGamer(dto: CreateGamerDto) {
    await this.assertBranchExists(dto.branchId);
    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.usersRepo
      .createGamer({ username: dto.username, passwordHash, homeBranchId: dto.branchId })
      .catch(usernameTaken);
    return toPublicUser(user);
  }

  /** A gamer changes the branch they play at (their booking page follows). */
  async setHomeBranch(caller: AccessTokenPayload, branchId: string) {
    const user = await this.usersRepo.findById(caller.sub);
    if (!user?.gamerProfile) {
      throw new ForbiddenException({ code: 'NOT_A_GAMER', error: 'only gamers have a home branch' });
    }
    await this.assertBranchExists(branchId);
    return toPublicUser(await this.usersRepo.setHomeBranch(caller.sub, branchId));
  }

  /**
   * Users for the staff app: everyone for HQ; for branch staff, every gamer
   * (customers of every branch) and their own branch's staff only.
   */
  async list(caller: AccessTokenPayload, query: ListUsersQuery) {
    const visibleBranchId = caller.scope === 'hq' ? null : caller.branchId;
    if (caller.scope !== 'hq' && !visibleBranchId) return [];
    const users = await this.usersRepo.list({ ...query, visibleBranchId });
    return users.map(toPublicUser);
  }

  /** The desk finds a gamer by username (top-ups, help): no member code to copy. */
  async searchGamers(q: string) {
    const users = await this.usersRepo.list({ q, role: 'GAMER', visibleBranchId: null, limit: 20 });
    return users.map(toPublicUser);
  }

  /**
   * Sets a new password for someone who lost theirs. HQ: anyone but
   * themselves. A manager: employees of their own branch, and gamers whose
   * home branch is theirs. Every login of the user ends.
   */
  async resetPassword(caller: AccessTokenPayload, targetId: string, newPassword: string) {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });
    if (target.id === caller.sub) {
      throw new ForbiddenException({ code: 'USE_CHANGE_PASSWORD', error: 'change your own password in your settings' });
    }
    if (caller.scope !== 'hq') {
      const ownEmployee = target.role === 'EMPLOYEE' && target.employeeProfile?.managedBranchId === caller.branchId;
      const ownGamer = target.role === 'GAMER' && target.gamerProfile?.homeBranchId === caller.branchId;
      if (!ownEmployee && !ownGamer) {
        throw new ForbiddenException({
          code: 'FORBIDDEN_ROLE_ESCALATION',
          error: "a manager can only reset their branch's employees and gamers",
        });
      }
    }
    await this.usersRepo.setPasswordHash(targetId, await this.passwords.hash(newPassword));
    await this.refreshTokens.revokeAllForUser(targetId);
    return { id: targetId, reset: true };
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    if (!(await this.usersRepo.branchExists(branchId))) {
      throw new BadRequestException({ code: 'BRANCH_NOT_FOUND', error: 'this branch does not exist' });
    }
  }

  /**
   * Suspends or reactivates an account. HQ: anyone but themselves. A manager:
   * only employees of their own branch. Suspending ends every login of the
   * user at once (their refresh tokens are revoked).
   */
  async setStatus(caller: AccessTokenPayload, targetId: string, status: 'ACTIVE' | 'SUSPENDED') {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });
    if (target.id === caller.sub) {
      throw new ForbiddenException({ code: 'FORBIDDEN_SELF_STATUS', error: 'cannot change your own account status' });
    }
    if (caller.scope !== 'hq') {
      if (target.role !== 'EMPLOYEE' || target.employeeProfile?.managedBranchId !== caller.branchId) {
        throw new ForbiddenException({
          code: 'FORBIDDEN_ROLE_ESCALATION',
          error: 'a manager can only suspend employees of their own branch',
        });
      }
    }
    const user = await this.usersRepo.setStatus(targetId, status);
    if (status !== 'ACTIVE') await this.refreshTokens.revokeAllForUser(targetId);
    return toPublicUser(user);
  }

  async createEmployee(caller: AccessTokenPayload, dto: CreateEmployeeDto) {
    this.assertCanAssignRole(caller, { newRole: dto.role, newBranchId: dto.branchId, currentBranchId: null });

    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.usersRepo
      .createEmployee({
        username: dto.username,
        passwordHash,
        role: dto.role,
        branchId: dto.branchId,
      })
      .catch(usernameTaken);
    return toPublicUser(user);
  }

  async updateRole(caller: AccessTokenPayload, targetId: string, dto: UpdateRoleDto) {
    const target = await this.usersRepo.findById(targetId);
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', error: 'user not found' });

    this.assertCanAssignRole(caller, {
      newRole: dto.role,
      newBranchId: dto.branchId,
      currentBranchId: target.employeeProfile?.managedBranchId ?? null,
      currentRole: target.role,
      targetId: target.id,
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
   * MANAGER (admin scope) may only create/promote to EMPLOYEE, only within
   * their own branch, and never touch a MANAGER or ADMIN (a peer or HQ) or
   * their own role. ADMIN (hq scope) bypasses all of it.
   */
  private assertCanAssignRole(
    caller: AccessTokenPayload,
    target: {
      newRole: UserRole;
      newBranchId?: string | null;
      currentBranchId: string | null;
      currentRole?: UserRole;
      targetId?: string;
    },
  ): void {
    if (caller.scope === 'hq') return;

    if (target.targetId === caller.sub) {
      throw new ForbiddenException({ code: 'FORBIDDEN_ROLE_ESCALATION', error: 'cannot change your own role' });
    }
    if (target.currentRole && ELEVATED_ROLES.includes(target.currentRole)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE_ESCALATION',
        error: 'cannot change the role of a MANAGER or ADMIN',
      });
    }

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

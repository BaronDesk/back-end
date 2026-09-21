import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '../generated/prisma/index.js';
import { IdentityRepository } from '../identity/identity.repository.js';
import { hashPassword } from '../identity/password.js';
import { AuthContext } from '../common/auth/scope.js';
import { CreateGamerDto, CreateEmployeeDto } from './users.dto.js';

@Injectable()
export class UsersService {
  constructor(private readonly identity: IdentityRepository) {}

  private async assertUsernameFree(username: string) {
    if (await this.identity.findUserByUsername(username)) throw new ConflictException('Username is already taken');
  }

  /** POST /users — public/staff. Creates a GAMER account with a linked profile. */
  async createGamer(input: CreateGamerDto) {
    await this.assertUsernameFree(input.username);
    const user = await this.identity.createGamerUser({ username: input.username, passwordHash: await hashPassword(input.password) });
    return { user };
  }

  /**
   * POST /employees — admin/hq. A branch MANAGER may only create staff for
   * their own branch; only hq (ADMIN role) may create MANAGERs or assign a
   * branch other than their own. requireScope's branch check already blocks a
   * manager from targeting a different branchId, this adds the role rule.
   */
  async createEmployee(input: CreateEmployeeDto, actor: AuthContext) {
    if (actor.scope === 'admin' && input.role === 'MANAGER') throw new ForbiddenException('Only hq can create a MANAGER account');
    await this.assertUsernameFree(input.username);
    const user = await this.identity.createEmployeeUser({
      username: input.username, passwordHash: await hashPassword(input.password),
      role: input.role as UserRole, managedBranchId: input.branchId, hireDate: input.hireDate ?? new Date(),
    });
    return { user };
  }

  /** PATCH /users/:id/role — admin/hq, with the same anti-escalation rule. */
  async updateUserRole(targetId: string, role: UserRole, actor: AuthContext) {
    if (actor.scope === 'admin' && (role === 'MANAGER' || role === 'ADMIN')) throw new ForbiddenException('Only hq can grant MANAGER or ADMIN');
    const target = await this.identity.findUserById(targetId);
    if (!target) throw new NotFoundException('User not found');
    if (actor.scope === 'admin') {
      const tb = await this.identity.findEmployeeProfileByUserId(targetId);
      if (tb?.managedBranchId !== actor.branchId) throw new ForbiddenException('You may only manage users in your own branch');
    }
    return { user: await this.identity.updateUserRole(targetId, role) };
  }

  /** GET /users/:id — self/staff. */
  async getUserById(id: string) {
    const user = await this.identity.findUserWithProfiles(id);
    if (!user) throw new NotFoundException('User not found');
    return { user };
  }
}

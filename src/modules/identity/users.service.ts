import { Inject, Injectable } from "@nestjs/common";
import { UserRole } from "../../generated/prisma";
import { IdentityRepository } from "./identity.repository";
import { hashPassword } from "../../lib/password";
import { ConflictError, ForbiddenError, NotFoundError } from "../../lib/app-error";
import { CreateEmployeeInput, CreateGamerInput } from "./identity.schemas";
import { AuthContext } from "../../shared/types/auth";

@Injectable()
export class UsersService {
  constructor(@Inject(IdentityRepository) private readonly repo: IdentityRepository) {}

  /** POST /users — public/staff. Creates a GAMER account with a linked profile. */
  async createGamer(input: CreateGamerInput) {
    await this.assertUsernameFree(input.username);
    const passwordHash = await hashPassword(input.password);

    const user = await this.repo.createGamerUser({ username: input.username, passwordHash });

    return { user };
  }

  /**
   * POST /employees — admin/hq. A branch MANAGER may only create staff for
   * their own branch; only hq (ADMIN role) may create MANAGERs or assign a
   * branch other than their own. The `@RequireScope` branch check already
   * blocks a manager from targeting a different branchId, this adds the role
   * rule.
   */
  async createEmployee(input: CreateEmployeeInput, actor: AuthContext) {
    if (actor.scope === "admin" && input.role === UserRole.MANAGER) {
      throw new ForbiddenError("Only hq can create a MANAGER account", "ROLE_ESCALATION_DENIED");
    }

    await this.assertUsernameFree(input.username);
    const passwordHash = await hashPassword(input.password);

    const user = await this.repo.createEmployeeUser({
      username: input.username,
      passwordHash,
      role: input.role,
      managedBranchId: input.branchId,
      hireDate: input.hireDate ?? new Date(),
    });

    return { user };
  }

  /** PATCH /users/:id/role — admin/hq, with the same anti-escalation rule. */
  async updateUserRole(targetId: string, role: UserRole, actor: AuthContext) {
    if (actor.scope === "admin" && (role === UserRole.MANAGER || role === UserRole.ADMIN)) {
      throw new ForbiddenError("Only hq can grant MANAGER or ADMIN", "ROLE_ESCALATION_DENIED");
    }

    const target = await this.repo.findUserById(targetId);
    if (!target) throw new NotFoundError("User not found");

    if (actor.scope === "admin") {
      const targetBranch = await this.repo.findEmployeeProfileByUserId(targetId);
      if (targetBranch?.managedBranchId !== actor.branchId) {
        throw new ForbiddenError("You may only manage users in your own branch");
      }
    }

    const user = await this.repo.updateUserRole(targetId, role);

    return { user };
  }

  /** GET /users/:id — self/staff. */
  async getUserById(id: string) {
    const user = await this.repo.findUserWithProfiles(id);
    if (!user) throw new NotFoundError("User not found");
    return { user };
  }

  private async assertUsernameFree(username: string) {
    const existing = await this.repo.findUserByUsername(username);
    if (existing) throw new ConflictError("Username is already taken", "USERNAME_TAKEN");
  }
}

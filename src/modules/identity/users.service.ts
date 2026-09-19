import { UserRole } from "@prisma/client";
import * as identityRepo from "./identity.repository";
import { hashPassword } from "../../lib/password";
import { ConflictError, ForbiddenError, NotFoundError } from "../../lib/app-error";
import { CreateEmployeeInput, CreateGamerInput } from "./identity.schemas";
import { AuthContext } from "../../shared/types/auth";

async function assertUsernameFree(username: string) {
  const existing = await identityRepo.findUserByUsername(username);
  if (existing) throw new ConflictError("Username is already taken", "USERNAME_TAKEN");
}

/** POST /users — public/staff. Creates a GAMER account with a linked profile. */
export async function createGamer(input: CreateGamerInput) {
  await assertUsernameFree(input.username);
  const passwordHash = await hashPassword(input.password);

  const user = await identityRepo.createGamerUser({ username: input.username, passwordHash });

  return { user };
}

/**
 * POST /employees — admin/hq. A branch MANAGER may only create staff for
 * their own branch; only hq (ADMIN role) may create MANAGERs or assign a
 * branch other than their own. requireScope's branch check already blocks a
 * manager from targeting a different branchId, this adds the role rule.
 */
export async function createEmployee(input: CreateEmployeeInput, actor: AuthContext) {
  if (actor.scope === "admin" && input.role === UserRole.MANAGER) {
    throw new ForbiddenError("Only hq can create a MANAGER account", "ROLE_ESCALATION_DENIED");
  }

  await assertUsernameFree(input.username);
  const passwordHash = await hashPassword(input.password);

  const user = await identityRepo.createEmployeeUser({
    username: input.username,
    passwordHash,
    role: input.role,
    managedBranchId: input.branchId,
    hireDate: input.hireDate ?? new Date(),
  });

  return { user };
}

/** PATCH /users/:id/role — admin/hq, with the same anti-escalation rule. */
export async function updateUserRole(targetId: string, role: UserRole, actor: AuthContext) {
  if (actor.scope === "admin" && (role === UserRole.MANAGER || role === UserRole.ADMIN)) {
    throw new ForbiddenError("Only hq can grant MANAGER or ADMIN", "ROLE_ESCALATION_DENIED");
  }

  const target = await identityRepo.findUserById(targetId);
  if (!target) throw new NotFoundError("User not found");

  if (actor.scope === "admin") {
    const targetBranch = await identityRepo.findEmployeeProfileByUserId(targetId);
    if (targetBranch?.managedBranchId !== actor.branchId) {
      throw new ForbiddenError("You may only manage users in your own branch");
    }
  }

  const user = await identityRepo.updateUserRole(targetId, role);

  return { user };
}

/** GET /users/:id — self/staff. */
export async function getUserById(id: string) {
  const user = await identityRepo.findUserWithProfiles(id);
  if (!user) throw new NotFoundError("User not found");
  return { user };
}

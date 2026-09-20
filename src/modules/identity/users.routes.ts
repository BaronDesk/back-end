import { FastifyInstance } from "fastify";
import { UserRole } from "@prisma/client";
import { validate } from "../../middleware/validate.middleware";
import { authenticate } from "../../middleware/auth.middleware";
import { requireScope } from "../../middleware/rbac.middleware";
import {
  CreateEmployeeInput,
  CreateGamerInput,
  createEmployeeSchema,
  createGamerSchema,
  getUserSchema,
  updateUserRoleSchema,
} from "./identity.schemas";
import {
  createEmployeeHandler,
  createGamerHandler,
  getUserHandler,
  updateUserRoleHandler,
} from "./users.controller";

export async function usersRoutes(app: FastifyInstance) {
  // POST /users — public/staff (self-serve signup or front-desk account creation)
  app.post<{ Body: CreateGamerInput }>(
    "/users",
    { preHandler: [validate(createGamerSchema)] },
    createGamerHandler
  );

  // POST /employees — admin/hq. A MANAGER may only target their own branch;
  // resolveBranchId reads the branch the caller is trying to create staff in.
  app.post<{ Body: CreateEmployeeInput }>(
    "/employees",
    {
      preHandler: [
        authenticate,
        requireScope("admin", {
          resolveBranchId: (req) => (req.body as { branchId?: string } | undefined)?.branchId,
        }),
        validate(createEmployeeSchema),
      ],
    },
    createEmployeeHandler
  );

  // PATCH /users/:id/role — admin/hq. Cross-branch/role-escalation rules are
  // enforced in the service layer since they depend on the *target* user.
  app.patch<{ Params: { id: string }; Body: { role: UserRole } }>(
    "/users/:id/role",
    { preHandler: [authenticate, requireScope("admin"), validate(updateUserRoleSchema)] },
    updateUserRoleHandler
  );

  // GET /users/:id — self/staff
  app.get<{ Params: { id: string } }>(
    "/users/:id",
    {
      preHandler: [authenticate, requireScope("self", { ownerParam: "id" }), validate(getUserSchema)],
    },
    getUserHandler
  );
}

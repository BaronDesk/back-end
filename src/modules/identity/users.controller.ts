import { Body, Controller, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import { UsersService } from "./users.service";
import { RequireScope } from "../../common/decorators/access.decorators";
import { CurrentAuth } from "../../common/decorators/current-auth.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuthContext } from "../../shared/types/auth";
import {
  CreateEmployeeInput,
  CreateGamerInput,
  UpdateUserRoleInput,
  UserIdParam,
  createEmployeeSchema,
  createGamerSchema,
  updateUserRoleSchema,
  userIdParamSchema,
} from "./identity.schemas";

// Routes live at the /api/v1 root: /users, /employees, /users/:id, /users/:id/role
@Controller()
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  // POST /users — public/staff (self-serve signup or front-desk account creation)
  @Public()
  @Post("users")
  createGamer(@Body(new ZodValidationPipe(createGamerSchema)) body: CreateGamerInput) {
    return this.users.createGamer(body);
  }

  // POST /employees — admin/hq. A MANAGER may only target their own branch;
  // resolveBranchId reads the branch the caller is trying to create staff in.
  @Post("employees")
  @RequireScope("admin", {
    resolveBranchId: (req) => (req.body as { branchId?: string } | undefined)?.branchId,
  })
  createEmployee(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeInput
  ) {
    return this.users.createEmployee(body, auth);
  }

  // PATCH /users/:id/role — admin/hq. Cross-branch/role-escalation rules are
  // enforced in the service layer since they depend on the *target* user.
  @Patch("users/:id/role")
  @RequireScope("admin")
  updateUserRole(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(userIdParamSchema)) params: UserIdParam,
    @Body(new ZodValidationPipe(updateUserRoleSchema)) body: UpdateUserRoleInput
  ) {
    return this.users.updateUserRole(params.id, body.role, auth);
  }

  // GET /users/:id — self/staff
  @Get("users/:id")
  @RequireScope("self", { ownerParam: "id" })
  getUser(@Param(new ZodValidationPipe(userIdParamSchema)) params: UserIdParam) {
    return this.users.getUserById(params.id);
  }
}

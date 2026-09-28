import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  createEmployeeSchema,
  createGamerSchema,
  idParamSchema,
  listUsersQuerySchema,
  updateAccountStatusSchema,
  updateEmploymentStatusSchema,
  updateRoleSchema,
  type CreateEmployeeDto,
  type CreateGamerDto,
  type ListUsersQueryDto,
  type UpdateAccountStatusDto,
  type UpdateEmploymentStatusDto,
  type UpdateRoleDto,
} from '../schemas/users.schemas.js';
import { UsersService } from '../services/users.service.js';

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Public()
  @Post('users')
  createGamer(@Body(new ZodValidationPipe(createGamerSchema)) dto: CreateGamerDto) {
    return this.users.createGamer(dto);
  }

  @RequireScope('admin')
  @Post('employees')
  createEmployee(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(createEmployeeSchema)) dto: CreateEmployeeDto,
  ) {
    return this.users.createEmployee(caller, dto);
  }

  @RequireScope('admin')
  @Patch('users/:id/role')
  updateRole(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) dto: UpdateRoleDto,
  ) {
    return this.users.updateRole(caller, id, dto);
  }

  @RequireScope('self')
  @Get('users/:id')
  getUser(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
  ) {
    return this.users.getUser(caller, id);
  }

  // staff(branch): staff/managers see their own branch's roster; hq sees everything, or one branch via ?branchId.
  @RequireScope('staff')
  @Get('users')
  list(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQueryDto,
  ) {
    return this.users.list(caller, query);
  }

  @RequireScope('admin')
  @Patch('users/:id/status')
  updateAccountStatus(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateAccountStatusSchema)) dto: UpdateAccountStatusDto,
  ) {
    return this.users.updateAccountStatus(caller, id, dto);
  }

  @RequireScope('admin')
  @Patch('users/:id/employment-status')
  updateEmploymentStatus(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateEmploymentStatusSchema)) dto: UpdateEmploymentStatusDto,
  ) {
    return this.users.updateEmploymentStatus(caller, id, dto);
  }
}

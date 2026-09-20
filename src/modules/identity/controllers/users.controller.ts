import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  createEmployeeSchema,
  createGamerSchema,
  idParamSchema,
  updateRoleSchema,
  type CreateEmployeeDto,
  type CreateGamerDto,
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
}

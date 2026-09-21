import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { ScopeGuard } from '../common/guards/scope.guard.js';
import { Scopes } from '../common/decorators/scopes.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AuthContext } from '../common/auth/scope.js';
import { UsersService } from './users.service.js';
import { CreateGamerDto, CreateEmployeeDto, UpdateUserRoleDto } from './users.dto.js';


@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('users') createGamer(@Body() dto: CreateGamerDto) { return this.users.createGamer(dto); }

  @UseGuards(JwtAuthGuard, ScopeGuard) @Scopes('admin', { branchParam: 'branchId' }) @Post('employees')
  createEmployee(@Body() dto: CreateEmployeeDto, @CurrentUser() user: AuthContext) { return this.users.createEmployee(dto, user); }

  @UseGuards(JwtAuthGuard, ScopeGuard) @Scopes('admin') @Patch('users/:id/role')
  updateRole(@Param('id') id: string, @Body() dto: UpdateUserRoleDto, @CurrentUser() user: AuthContext) { return this.users.updateUserRole(id, dto.role, user); }

  @UseGuards(JwtAuthGuard, ScopeGuard) @Scopes('self', { ownerParam: 'id' }) @Get('users/:id')
  getUser(@Param('id') id: string) { return this.users.getUserById(id); }
}

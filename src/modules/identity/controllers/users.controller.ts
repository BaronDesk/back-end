import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { ClientIp } from '../../../common/decorators/client-ip.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RateLimiter } from '../../../common/rate-limit/rate-limiter.service.js';
import { authRateLimits, type AuthRateLimits } from '../../../common/rate-limit/rate-limits.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  createEmployeeSchema,
  createGamerSchema,
  idParamSchema,
  homeBranchSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  searchGamersQuerySchema,
  updateRoleSchema,
  updateStatusSchema,
  type CreateEmployeeDto,
  type CreateGamerDto,
  type HomeBranchDto,
  type ListUsersQuery,
  type ResetPasswordDto,
  type SearchGamersQuery,
  type UpdateRoleDto,
  type UpdateStatusDto,
} from '../schemas/users.schemas.js';
import { IMAGE_UPLOAD_BODY } from '../../uploads/controllers/uploads.controller.js';
import { readUpload } from '../../uploads/util/read-upload.js';
import { UsersService } from '../services/users.service.js';

@Controller()
export class UsersController {
  private readonly limits: AuthRateLimits;

  constructor(
    private readonly users: UsersService,
    private readonly limiter: RateLimiter,
    config: ConfigService,
  ) {
    this.limits = authRateLimits((key) => config.get(key));
  }

  @Public()
  @Post('users')
  async createGamer(@ClientIp() ip: string, @Body(new ZodValidationPipe(createGamerSchema)) dto: CreateGamerDto) {
    await this.limiter.consume(`signup:${ip}`, this.limits.signups);
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

  /** Accounts for the staff app (HQ: everyone; branch staff: gamers and their own staff). */
  @RequireScope('staff')
  @Get('users')
  list(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery,
  ) {
    return this.users.list(caller, query);
  }

  /** The desk finds a gamer by username (top-up, help). */
  @RequireScope('staff')
  @Get('gamers')
  searchGamers(@Query(new ZodValidationPipe(searchGamersQuerySchema)) query: SearchGamersQuery) {
    return this.users.searchGamers(query.q);
  }

  /** A gamer changes the branch they play at. */
  @RequireScope('self')
  @Patch('users/me/branch')
  setHomeBranch(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(homeBranchSchema)) dto: HomeBranchDto,
  ) {
    return this.users.setHomeBranch(caller, dto.branchId);
  }

  /** A gamer's profile picture (PNG, JPEG or WebP, at most 2 MB), cropped to a 256×256 square. */
  @RequireScope('self')
  @Put('users/me/avatar')
  @ApiConsumes('multipart/form-data')
  @ApiBody(IMAGE_UPLOAD_BODY)
  async setAvatar(@CurrentUser() caller: AccessTokenPayload, @Req() req: FastifyRequest) {
    return this.users.setAvatar(caller, await readUpload(req));
  }

  @RequireScope('self')
  @Delete('users/me/avatar')
  removeAvatar(@CurrentUser() caller: AccessTokenPayload) {
    return this.users.removeAvatar(caller);
  }

  /** New password for someone who lost theirs: HQ anyone, a manager their branch's employees and gamers. */
  @RequireScope('admin')
  @HttpCode(200)
  @Post('users/:id/password')
  resetPassword(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(caller, id, dto.newPassword);
  }

  /** Suspend / reactivate: HQ anyone, a manager their own branch's employees. */
  @RequireScope('admin')
  @Patch('users/:id/status')
  setStatus(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateStatusSchema)) dto: UpdateStatusDto,
  ) {
    return this.users.setStatus(caller, id, dto.status);
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

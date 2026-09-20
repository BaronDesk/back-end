import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { loginSchema, logoutSchema, refreshSchema, type LoginDto, type LogoutDto, type RefreshDto } from '../schemas/auth.schemas.js';
import { AuthService } from '../services/auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @RequireScope('self')
  @HttpCode(200)
  @Post('logout')
  logout(@Body(new ZodValidationPipe(logoutSchema)) dto: LogoutDto) {
    return this.auth.logout(dto);
  }

  @RequireScope('self')
  @Get('me')
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.auth.me(user);
  }
}

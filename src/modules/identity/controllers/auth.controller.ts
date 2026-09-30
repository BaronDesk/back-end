import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';

import { ClientIp } from '../../../common/decorators/client-ip.decorator.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { RateLimiter } from '../../../common/rate-limit/rate-limiter.service.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { loginSchema, logoutSchema, refreshSchema, type LoginDto, type LogoutDto, type RefreshDto } from '../schemas/auth.schemas.js';
import { changePasswordSchema, type ChangePasswordDto } from '../schemas/users.schemas.js';
import { AuthService } from '../services/auth.service.js';

/** Wrong passwords per IP + username before login is refused for a while. */
const LOGIN_FAILURES = { limit: 10, windowS: 15 * 60 };
/** Refreshes per IP: a client refreshes every ~15 min, so this is generous. */
const REFRESHES = { limit: 60, windowS: 60 };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limiter: RateLimiter,
  ) {}

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@ClientIp() ip: string, @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto) {
    const key = `login:${ip}:${dto.username.toLowerCase()}`;
    await this.limiter.assertUnder(key, LOGIN_FAILURES);
    try {
      const tokens = await this.auth.login(dto);
      await this.limiter.reset(key);
      return tokens;
    } catch (err) {
      await this.limiter.hit(key, LOGIN_FAILURES);
      throw err;
    }
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@ClientIp() ip: string, @Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    await this.limiter.consume(`refresh:${ip}`, REFRESHES);
    return this.auth.refresh(dto);
  }

  @RequireScope('self')
  @HttpCode(200)
  @Post('logout')
  logout(@Body(new ZodValidationPipe(logoutSchema)) dto: LogoutDto) {
    return this.auth.logout(dto);
  }

  /** Own password; answers with a fresh token pair (every other login ends). */
  @RequireScope('self')
  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(changePasswordSchema)) dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(caller, dto);
  }

  @RequireScope('self')
  @Get('me')
  me(@CurrentUser() user: AccessTokenPayload) {
    return this.auth.me(user);
  }
}

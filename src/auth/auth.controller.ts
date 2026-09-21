import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AuthContext } from '../common/auth/scope.js';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, LogoutDto } from './auth.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto); }
  @Post('refresh') refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }

  @UseGuards(JwtAuthGuard) @Post('logout') @HttpCode(204)
  logout(@CurrentUser() user: AuthContext, @Body() dto: LogoutDto) { return this.auth.logout(user.sub, dto); }

  @UseGuards(JwtAuthGuard) @Get('me')
  me(@CurrentUser() user: AuthContext) { return this.auth.me(user.sub); }
}

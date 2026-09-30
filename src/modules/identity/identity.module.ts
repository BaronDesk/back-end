import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { RateLimiter } from '../../common/rate-limit/rate-limiter.service.js';
import { AuthController } from './controllers/auth.controller.js';
import { UsersController } from './controllers/users.controller.js';
import { RefreshTokenRepository } from './repository/refresh-token.repository.js';
import { UsersRepository } from './repository/users.repository.js';
import { AuthService } from './services/auth.service.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';
import { UsersService } from './services/users.service.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: config.getOrThrow('JWT_ACCESS_TTL') },
      }),
    }),
  ],
  controllers: [AuthController, UsersController],
  providers: [
    RateLimiter,
    AuthService,
    UsersService,
    TokenService,
    PasswordService,
    UsersRepository,
    RefreshTokenRepository,
  ],
  exports: [TokenService, UsersService],
})
export class IdentityModule {}

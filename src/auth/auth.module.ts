import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { JwtAccessStrategy } from './jwt-access.strategy.js';
import { IdentityModule } from '../identity/identity.module.js';

@Module({
  imports: [
    IdentityModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule], inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_ACCESS_SECRET') }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtAccessStrategy],
  exports: [TokenService],
})
export class AuthModule {}
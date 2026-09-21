import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AccessTokenClaims, AuthContext } from '../common/auth/scope.js';

@Injectable()
export class JwtAccessStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          ignoreExpiration: false,
          secretOrKey: config.getOrThrow('JWT_ACCESS_SECRET'),
          issuer: config.get('JWT_ISSUER') ?? 'cstam-identity',
    });
  }

  validate(payload: AccessTokenClaims): AuthContext {
    return { sub: payload.sub, role: payload.role, scope: payload.scope, branchId: payload.branchId, jti: payload.jti };
  }
}

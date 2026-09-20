import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AccessTokenPayload } from '../types/jwt-payload.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

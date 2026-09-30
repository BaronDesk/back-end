import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** The caller's IP. Fastify runs with trustProxy (Caddy in front), so this is the real client. */
export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<{ ip?: string }>().ip ?? 'unknown',
);

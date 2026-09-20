import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let error = 'internal server error';
    let issues: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        error = body;
        code = HttpStatus[status] ?? 'ERROR';
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        error = (b.error as string) ?? (b.message as string) ?? exception.message;
        code = (b.code as string) ?? HttpStatus[status] ?? 'ERROR';
        issues = b.issues;
      }
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      error = exception.message;
    } else {
      this.logger.error(`unknown exception: ${String(exception)}`);
    }

    reply.status(status).send({ error, code, ...(issues ? { issues } : {}) });
  }
}

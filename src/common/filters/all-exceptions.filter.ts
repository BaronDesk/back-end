import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Prisma } from '../../generated/prisma/index.js';

/**
 * Database errors that mean something to the client. Anything else from the
 * database is an internal error.
 */
const PRISMA_ERRORS: Record<string, { status: number; code: string; error: string }> = {
  P2002: { status: HttpStatus.CONFLICT, code: 'CONFLICT', error: 'this record already exists' },
  P2025: { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND', error: 'record not found' },
  P2003: { status: HttpStatus.CONFLICT, code: 'CONFLICT', error: 'the record is still referenced elsewhere' },
};

/**
 * One error shape for every answer: `{ error, code, issues? }`. Only
 * HttpExceptions (thrown on purpose, with a message meant for the client)
 * reach the client as written; any other error is logged in full and
 * answered with a generic message, so internals never leak.
 */
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
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && PRISMA_ERRORS[exception.code]) {
      ({ status, code, error } = PRISMA_ERRORS[exception.code]);
      this.logger.warn(`database ${exception.code}: ${exception.message}`);
    } else if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(`unknown exception: ${String(exception)}`);
    }

    reply.status(status).send({ error, code, ...(issues ? { issues } : {}) });
  }
}

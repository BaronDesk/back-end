import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, NotFoundException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/app-error";
import { env } from "../../config/env";

interface ErrorBody {
  error: string;
  code: string;
}

/**
 * Turns every error into the API's `{ error, code }` shape:
 *  - AppError (and subclasses) -> its own status + code
 *  - Nest's "no such route" -> 404 ROUTE_NOT_FOUND
 *  - other HttpExceptions and Fastify's own 4xx (malformed JSON, payload too
 *    large, ...) -> passed through with their status
 *  - anything else -> 500 INTERNAL_ERROR (message hidden in production)
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const { status, body } = this.toResponse(exception, req);
    void reply.status(status).send(body);
  }

  private toResponse(exception: unknown, req: FastifyRequest): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return { status: exception.status, body: { error: exception.message, code: exception.code } };
    }

    if (exception instanceof NotFoundException) {
      return {
        status: 404,
        body: { error: `No route for ${req.method} ${req.url.split("?")[0]}`, code: "ROUTE_NOT_FOUND" },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, body: { error: exception.message, code: status === 400 ? "BAD_REQUEST" : `HTTP_${status}` } };
    }

    const fe = exception as { statusCode?: number; code?: string; message?: string };
    if (fe?.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return { status: fe.statusCode, body: { error: String(fe.message), code: fe.code ?? "BAD_REQUEST" } };
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return {
      status: 500,
      body: {
        error: env.nodeEnv === "production" ? "Internal server error" : String(fe?.message ?? exception),
        code: "INTERNAL_ERROR",
      },
    };
  }
}

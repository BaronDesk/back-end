import { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../lib/app-error";
import { env } from "../config/env";

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  reply
    .status(404)
    .send({ error: `No route for ${req.method} ${req.url.split("?")[0]}`, code: "ROUTE_NOT_FOUND" });
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.status).send({ error: err.message, code: err.code });
  }

  // Errors raised by Fastify itself (malformed JSON, unsupported content type,
  // payload too large, ...) carry a 4xx statusCode — pass them through.
  const fe = err as { statusCode?: number; code?: string; message?: string };
  if (fe?.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.status(fe.statusCode).send({ error: fe.message, code: fe.code ?? "BAD_REQUEST" });
  }

  req.log.error(err);
  return reply.status(500).send({
    error: env.nodeEnv === "production" ? "Internal server error" : String(fe?.message ?? err),
    code: "INTERNAL_ERROR",
  });
}

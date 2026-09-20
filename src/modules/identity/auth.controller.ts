import { FastifyReply, FastifyRequest } from "fastify";
import * as authService from "./auth.service";
import { UnauthorizedError } from "../../lib/app-error";
import { LoginInput, LogoutInput, RefreshInput } from "./identity.schemas";

export async function loginHandler(req: FastifyRequest<{ Body: LoginInput }>, reply: FastifyReply) {
  const result = await authService.login(req.body);
  return reply.status(200).send(result);
}

export async function refreshHandler(req: FastifyRequest<{ Body: RefreshInput }>, reply: FastifyReply) {
  const result = await authService.refresh(req.body.refreshToken);
  return reply.status(200).send(result);
}

export async function logoutHandler(req: FastifyRequest<{ Body: LogoutInput }>, reply: FastifyReply) {
  if (!req.auth) throw new UnauthorizedError();
  await authService.logout(req.auth.sub, { jti: req.body.jti, refreshToken: req.body.refreshToken });
  return reply.status(204).send();
}

export async function meHandler(req: FastifyRequest, reply: FastifyReply) {
  if (!req.auth) throw new UnauthorizedError();
  const result = await authService.me(req.auth.sub);
  return reply.status(200).send(result);
}

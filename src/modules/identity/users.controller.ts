import { FastifyReply, FastifyRequest } from "fastify";
import { UserRole } from "@prisma/client";
import * as usersService from "./users.service";
import { UnauthorizedError } from "../../lib/app-error";
import { CreateEmployeeInput, CreateGamerInput } from "./identity.schemas";

export async function createGamerHandler(req: FastifyRequest<{ Body: CreateGamerInput }>, reply: FastifyReply) {
  const result = await usersService.createGamer(req.body);
  return reply.status(201).send(result);
}

export async function createEmployeeHandler(
  req: FastifyRequest<{ Body: CreateEmployeeInput }>,
  reply: FastifyReply
) {
  if (!req.auth) throw new UnauthorizedError();
  const result = await usersService.createEmployee(req.body, req.auth);
  return reply.status(201).send(result);
}

export async function updateUserRoleHandler(
  req: FastifyRequest<{ Params: { id: string }; Body: { role: UserRole } }>,
  reply: FastifyReply
) {
  if (!req.auth) throw new UnauthorizedError();
  const result = await usersService.updateUserRole(req.params.id, req.body.role, req.auth);
  return reply.status(200).send(result);
}

export async function getUserHandler(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const result = await usersService.getUserById(req.params.id);
  return reply.status(200).send(result);
}

import { FastifyInstance } from "fastify";
import { authRoutes } from "../modules/identity/auth.routes";
import { usersRoutes } from "../modules/identity/users.routes";

export async function apiRoutes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(usersRoutes); // exposes /users, /employees, /users/:id/role at the /api/v1 root
}

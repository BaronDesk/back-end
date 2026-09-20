import { FastifyInstance } from "fastify";
import { validate } from "../../middleware/validate.middleware";
import { authenticate } from "../../middleware/auth.middleware";
import {
  LoginInput,
  LogoutInput,
  RefreshInput,
  loginSchema,
  logoutSchema,
  refreshSchema,
} from "./identity.schemas";
import { loginHandler, logoutHandler, meHandler, refreshHandler } from "./auth.controller";

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/login — public
  app.post<{ Body: LoginInput }>("/login", { preHandler: [validate(loginSchema)] }, loginHandler);

  // POST /auth/refresh — public (the refresh token itself is the credential)
  app.post<{ Body: RefreshInput }>("/refresh", { preHandler: [validate(refreshSchema)] }, refreshHandler);

  // POST /auth/logout — self
  app.post<{ Body: LogoutInput }>(
    "/logout",
    { preHandler: [authenticate, validate(logoutSchema)] },
    logoutHandler
  );

  // GET /auth/me — self
  app.get("/me", { preHandler: [authenticate] }, meHandler);
}

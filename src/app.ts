import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { apiRoutes } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { registerJwt } from "./lib/jwt";
import { prisma } from "./lib/prisma";
import { env } from "./config/env";
import { agentGateway } from "./modules/ops/agent-gateway";
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

export async function createApp() {
  const app = Fastify({ logger: env.nodeEnv !== "test" });

  await app.register(helmet);
  await app.register(cors);
  await registerJwt(app);

  // `auth` is set per-request by the `authenticate` hook.
  app.decorateRequest("auth", undefined);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(apiRoutes, { prefix: "/api/v1" });
  await app.register(agentGateway);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  return app;
}

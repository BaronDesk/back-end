import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { env } from "./config/env";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await configureApp(app);

  // SIGINT/SIGTERM -> onModuleDestroy hooks (Prisma disconnect, sockets) -> exit.
  app.enableShutdownHooks();

  await app.listen(env.port, "0.0.0.0");
  Logger.log(`[identity] listening on :${env.port} (${env.nodeEnv})`, "Bootstrap");
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

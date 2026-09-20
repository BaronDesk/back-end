import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Caddy sits in front, so X-Forwarded-For is the only real client IP you get.
    new FastifyAdapter({ trustProxy: true }),
  );

  // Without this, SIGTERM kills the process before Prisma disconnects
  // cleanly on every `docker compose restart`.
  app.enableShutdownHooks();

  if (process.env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
      .setTitle('cstam backend')
      .setVersion('0.1')
      .addBearerAuth()
      .build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`listening on :${port}`, 'Bootstrap');
}
void bootstrap();

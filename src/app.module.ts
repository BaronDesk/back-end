import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Redis } from 'ioredis';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { OpsModule } from './ops/ops.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

        BullModule.forRootAsync({
          inject: [ConfigService],
          useFactory: (cfg: ConfigService) => ({
            // BullMQ workers block on BRPOPLPUSH. ioredis's default retry cap kills
            // that connection with MaxRetriesPerRequestError; null is mandatory.
            connection: new Redis(cfg.getOrThrow('REDIS_URL'), {
              maxRetriesPerRequest: null,
            }),
            defaultJobOptions: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: { age: 3600, count: 1000 },
              removeOnFail: { age: 86400 },
            },
          }),
        }),

        PrismaModule,
        HealthModule,
        OpsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

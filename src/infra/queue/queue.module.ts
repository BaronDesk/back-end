import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared BullMQ connection. BullMQ opens its own ioredis clients from the URL
 * (workers need `maxRetriesPerRequest: null`, which the app's REDIS client
 * deliberately does not use). Modules register their queues with
 * `BullModule.registerQueue`.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: { url: config.getOrThrow<string>('REDIS_URL') },
        // Two app processes on one Redis (dev server + e2e run) must not
        // share queues: a worker without the station's socket would fail it.
        prefix: config.get<string>('BULLMQ_PREFIX') ?? 'bull',
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}

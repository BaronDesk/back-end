import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { Public } from '../common/decorators/public.decorator.js';
import { PrismaService } from '../infra/prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  async check() {
    const [postgres, redis] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => 'up' as const)
        .catch((e: Error) => `down: ${e.message}`),
      this.pingRedis(),
    ]);

    const body = {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'degraded',
      uptime: Math.round(process.uptime()),
      checks: { postgres, redis },
    };

    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }

  private async pingRedis(): Promise<'up' | `down: ${string}`> {
    const client = new Redis(this.config.getOrThrow('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    try {
      await client.connect();
      await client.ping();
      return 'up';
    } catch (e) {
      return `down: ${(e as Error).message}`;
    } finally {
      client.disconnect();
    }
  }
}

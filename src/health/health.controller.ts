import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service.js';
import { COMMANDS_QUEUE } from '../ops/commands.constants.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(COMMANDS_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  async check() {
    const [postgres, redis] = await Promise.all([
      this.prisma
        .$queryRaw`SELECT 1`
        .then(() => 'up' as const)
        .catch((e: Error) => `down: ${e.message}`),
      this.queue
        .getBackend().client
        .then((c: any) => c.ping())
        .then(() => 'up' as const)
        .catch((e: Error) => `down: ${e.message}`),
    ]);

    const body = {
      status: postgres === 'up' && redis === 'up' ? 'ok' : 'degraded',
      uptime: Math.round(process.uptime()),
      checks: { postgres, redis },
    };

    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}

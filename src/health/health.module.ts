import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { HealthController } from './health.controller.js';
import { COMMANDS_QUEUE } from '../ops/commands.constants.js';

@Module({
  imports: [BullModule.registerQueue({ name: COMMANDS_QUEUE })],
  controllers: [HealthController],
})
export class HealthModule {}

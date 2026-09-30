import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AppConfigModule } from './config/config.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { PrismaModule } from './infra/prisma/prisma.module.js';
import { QueueModule } from './infra/queue/queue.module.js';
import { RedisModule } from './infra/redis/redis.module.js';
import { HealthModule } from './health/health.module.js';
import { GamesModule } from './modules/games/games.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { MachinesModule } from './modules/machines/machines.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { StationModule } from './modules/station/station.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { MembershipModule } from './modules/membership/membership.module.js';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module.js';
import { SessionBillingModule } from './modules/session-billing/session-billing.module.js';
import { ReservationsModule } from './modules/reservations/reservations.module.js';


@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    IdentityModule,
    MachinesModule,
    StationModule,
    GamesModule,
    OpsModule,
    PricingModule,
    WalletModule,
    MembershipModule,
    SubscriptionsModule,
    ReservationsModule,
    SessionBillingModule,
    HealthModule,
  ],

  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}

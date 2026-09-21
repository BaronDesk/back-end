import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { IdentityModule } from "./modules/identity/identity.module";
import { OpsModule } from "./modules/ops/ops.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SecurityModule } from "./security/security.module";

@Module({
  imports: [PrismaModule, SecurityModule, IdentityModule, OpsModule],
  controllers: [HealthController],
})
export class AppModule {}

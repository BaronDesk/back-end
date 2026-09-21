import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { IdentityRepository } from "./identity.repository";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

/**
 * Owns User, EmployeeProfile, GamerProfile, RefreshToken and AuditLog. Other
 * modules reach this data only through the exported services.
 */
@Module({
  controllers: [AuthController, UsersController],
  providers: [IdentityRepository, AuthService, UsersService],
  exports: [AuthService, UsersService],
})
export class IdentityModule {}

import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { TokenService } from "./token.service";

/**
 * Global so any module's controllers can use the auth/RBAC guards in
 * `common/guards` without importing anything. Secrets are passed per call by
 * TokenService (access and refresh use different ones), so JwtModule is
 * registered with no defaults.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [TokenService],
  exports: [TokenService],
})
export class SecurityModule {}

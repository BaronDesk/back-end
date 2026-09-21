import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { Auth } from "../../common/decorators/access.decorators";
import { CurrentAuth } from "../../common/decorators/current-auth.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { AuthContext } from "../../shared/types/auth";
import {
  LoginInput,
  LogoutInput,
  RefreshInput,
  loginSchema,
  logoutSchema,
  refreshSchema,
} from "./identity.schemas";

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  // POST /auth/login — public
  @Public()
  @Post("login")
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginSchema)) body: LoginInput) {
    return this.auth.login(body);
  }

  // POST /auth/refresh — public (the refresh token itself is the credential)
  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(refreshSchema)) body: RefreshInput) {
    return this.auth.refresh(body.refreshToken);
  }

  // POST /auth/logout — self
  @Post("logout")
  @HttpCode(204)
  @Auth()
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(logoutSchema)) body: LogoutInput
  ): Promise<void> {
    await this.auth.logout(auth.sub, { jti: body.jti, refreshToken: body.refreshToken });
  }

  // GET /auth/me — self
  @Get("me")
  @Auth()
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth.sub);
  }
}

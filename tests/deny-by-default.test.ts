import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Auth } from "../src/common/decorators/access.decorators";
import { Public } from "../src/common/decorators/public.decorator";
import { DenyByDefaultGuard } from "../src/common/guards/deny-by-default.guard";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { SecurityModule } from "../src/security/security.module";

// A throwaway controller exercising all three outcomes DenyByDefaultGuard
// cares about. AppModule's real controllers are all already decorated, so
// this is the only way to prove the "forgot the decorator" case is rejected.
@Controller("probe")
class ProbeController {
  @Get("undecorated")
  undecorated() {
    return { ok: true };
  }

  @Public()
  @Get("public")
  public() {
    return { ok: true };
  }

  @Auth()
  @Get("authed")
  authed() {
    return { ok: true };
  }
}

@Module({
  imports: [SecurityModule],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: DenyByDefaultGuard }],
})
class ProbeModule {}

describe("DenyByDefaultGuard", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a route with no @Public()/@Auth()/@RequireScope()/@AllowAny() marker", async () => {
    const res = await app.inject({ method: "GET", url: "/probe/undecorated" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("NO_ACCESS_POLICY");
  });

  it("allows a route marked @Public() through with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/probe/public" });
    expect(res.statusCode).toBe(200);
  });

  it("lets @Auth() do its own job — missing token is 401, not 403", async () => {
    const res = await app.inject({ method: "GET", url: "/probe/authed" });
    expect(res.statusCode).toBe(401);
  });
});

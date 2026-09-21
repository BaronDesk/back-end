import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";

@Controller("health")
export class HealthController {
  // GET /health — outside the /api/v1 prefix (see app.setup.ts)
  @Public()
  @Get()
  check() {
    return { status: "ok" };
  }
}

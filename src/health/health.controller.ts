import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  // GET /health — outside the /api/v1 prefix (see app.setup.ts)
  @Get()
  check() {
    return { status: "ok" };
  }
}

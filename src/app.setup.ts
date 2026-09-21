import { RequestMethod } from "@nestjs/common";
import { NestFastifyApplication } from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

/**
 * Everything that configures the HTTP app beyond the module graph. Shared by
 * `main.ts` and the tests (`tests/helpers/app.ts`) so both run the same setup.
 */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.setGlobalPrefix("api/v1", { exclude: [{ path: "health", method: RequestMethod.GET }] });

  await app.register(helmet);
  app.enableCors();

  app.useGlobalFilters(new AllExceptionsFilter());

  // `auth` is set per-request by the auth guards.
  app.getHttpAdapter().getInstance().decorateRequest("auth", undefined);
}

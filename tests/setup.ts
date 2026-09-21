import "reflect-metadata";
import { beforeEach } from "vitest";
import { fakePrisma } from "./helpers/db";

// The app under test gets `fakePrisma` via overrideProvider(PrismaService)
// (see tests/helpers/app.ts); here we only wipe it between tests.
beforeEach(() => {
  fakePrisma.__reset();
});

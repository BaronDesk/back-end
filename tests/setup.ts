import { beforeEach, vi } from "vitest";

// Replace the real Prisma client with the in-memory fake for every test file.
vi.mock("../src/lib/prisma", async () => {
  const { createFakePrisma } = await import("./helpers/fake-prisma");
  return { prisma: createFakePrisma() };
});

import { prisma } from "../src/lib/prisma";
import type { FakePrisma } from "./helpers/fake-prisma";

beforeEach(() => {
  (prisma as unknown as FakePrisma).__reset();
});
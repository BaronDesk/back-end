import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

// Standard singleton pattern so dev hot-reload (tsx watch) doesn't spawn a new
// PrismaClient (and a new connection pool) on every file change.
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma =
  global.__prisma ??
  new PrismaClient({
    log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
  });

if (env.nodeEnv !== "production") {
  global.__prisma = prisma;
}

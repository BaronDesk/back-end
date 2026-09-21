import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma";
import { env } from "../config/env";

/**
 * The one PrismaClient for the process. Nest's DI guarantees a single instance,
 * so the old `global.__prisma` hot-reload trick is no longer needed.
 *
 * Only a module's own `<name>.repository.ts` may inject this (see
 * ARCHITECTURE.md, "Module DB privacy").
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: env.databaseUrl }),
      log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

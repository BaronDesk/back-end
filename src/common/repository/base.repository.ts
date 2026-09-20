import type { PrismaService } from '../../infra/prisma/prisma.service.js';

/**
 * Anchors the module-privacy rule: a repository is the only place a module
 * touches its own Prisma tables. Nothing outside a repository should import
 * PrismaService directly.
 */
export abstract class BaseRepository {
  protected constructor(protected readonly prisma: PrismaService) {}
}

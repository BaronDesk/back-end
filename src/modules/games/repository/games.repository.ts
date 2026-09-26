import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/index.js';

@Injectable()
export class GamesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list(enabledOnly: boolean) {
    return this.prisma.game.findMany({
      where: enabledOnly ? { enabled: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.game.findUnique({ where: { id } });
  }

  findBySlug(slug: string) {
    return this.prisma.game.findUnique({ where: { slug } });
  }

  create(data: Prisma.GameCreateInput) {
    return this.prisma.game.create({ data });
  }

  update(id: string, data: Prisma.GameUpdateInput) {
    return this.prisma.game.update({ where: { id }, data });
  }
}

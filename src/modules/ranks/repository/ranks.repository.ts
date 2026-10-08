import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { CreateRankDto, UpdateRankDto } from '../schemas/ranks.schemas.js';

@Injectable()
export class RanksRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list() {
    return this.prisma.rank.findMany({ orderBy: { minXp: 'asc' } });
  }

  find(id: string) {
    return this.prisma.rank.findUnique({ where: { id } });
  }

  create(data: CreateRankDto) {
    return this.prisma.rank.create({ data });
  }

  update(id: string, data: UpdateRankDto) {
    return this.prisma.rank.update({ where: { id }, data });
  }

  delete(id: string) {
    return this.prisma.rank.delete({ where: { id } });
  }
}

import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

/**
 * Reads, never writes, the other modules' image columns: a file is deleted
 * only once no row points at it. A new image column must be added here.
 */
@Injectable()
export class ImagesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async isUsed(url: string): Promise<boolean> {
    const counts = await Promise.all([
      this.prisma.membershipPlan.count({ where: { badgeUrl: url } }),
      this.prisma.subscriptionPlan.count({ where: { badgeUrl: url } }),
      this.prisma.rank.count({ where: { badgeUrl: url } }),
      this.prisma.game.count({ where: { iconUrl: url } }),
      this.prisma.gamerProfile.count({ where: { avatarUrl: url } }),
    ]);
    return counts.some((n) => n > 0);
  }
}

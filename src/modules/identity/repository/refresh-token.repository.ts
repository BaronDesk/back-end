import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';

@Injectable()
export class RefreshTokenRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  create(data: { jti: string; userId: string; expiresAt: Date }) {
    return this.prisma.refreshToken.create({ data });
  }

  findByJti(jti: string) {
    return this.prisma.refreshToken.findUnique({ where: { jti } });
  }

  revoke(jti: string, replacedByJti?: string) {
    return this.prisma.refreshToken.update({
      where: { jti },
      data: { revoked: true, ...(replacedByJti ? { replacedByJti } : {}) },
    });
  }
}

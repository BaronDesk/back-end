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

  /** Every live refresh token of the user: suspension, a password change, or a reused (stolen) token. */
  revokeAllForUser(userId: string, exceptJti?: string) {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false, ...(exceptJti ? { jti: { not: exceptJti } } : {}) },
      data: { revoked: true },
    });
  }

  revoke(jti: string, replacedByJti?: string) {
    return this.prisma.refreshToken.update({
      where: { jti },
      data: { revoked: true, ...(replacedByJti ? { replacedByJti } : {}) },
    });
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/index.js';
import { ImagesService } from '../../uploads/services/images.service.js';
import { RanksRepository } from '../repository/ranks.repository.js';
import type { CreateRankDto, UpdateRankDto } from '../schemas/ranks.schemas.js';

const notFound = () => new NotFoundException({ code: 'RANK_NOT_FOUND', error: 'rank not found' });

/**
 * The gamer ranks (Wood → GrandMaster), each with the XP it starts at and its
 * badge. A gamer's rank is the highest one whose minXp is at or below their XP.
 */
@Injectable()
export class RanksService {
  constructor(
    private readonly repo: RanksRepository,
    private readonly images: ImagesService,
  ) {}

  list() {
    return this.repo.list();
  }

  async create(dto: CreateRankDto) {
    try {
      return await this.repo.create(dto);
    } catch (error) {
      translateUniqueError(error);
    }
  }

  async update(id: string, dto: UpdateRankDto) {
    const existing = await this.repo.find(id);
    if (!existing) throw notFound();
    try {
      const updated = await this.repo.update(id, dto);
      await this.images.release(existing.badgeUrl);
      return updated;
    } catch (error) {
      translateUniqueError(error);
    }
  }

  async remove(id: string) {
    const existing = await this.repo.find(id);
    if (!existing) throw notFound();
    await this.repo.delete(id);
    await this.images.release(existing.badgeUrl);
    return { id, deleted: true };
  }
}

/** name and minXp are both unique: two ranks cannot share either. */
function translateUniqueError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = String(error.meta?.target ?? '');
    throw target.includes('min_xp') || target.includes('minXp')
      ? new ConflictException({ code: 'RANK_XP_TAKEN', error: 'another rank already starts at this XP' })
      : new ConflictException({ code: 'RANK_NAME_TAKEN', error: 'another rank already has this name' });
  }
  throw error;
}

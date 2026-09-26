import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import { SCOPE_RANK } from '../../../common/utils/scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { Game } from '../../../generated/prisma/index.js';
import { GamesRepository } from '../repository/games.repository.js';
import type { CreateGameDto, UpdateGameDto } from '../schemas/games.schemas.js';

/** API shape of a catalog entry. */
export function toGameDto(game: Game) {
  return {
    id: game.id,
    name: game.name,
    slug: game.slug,
    launchRef: game.launchRef,
    iconUrl: game.iconUrl,
    enabled: game.enabled,
    sortOrder: game.sortOrder,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  };
}

/**
 * The backend-side game catalog. The desktop agent does not know about it:
 * LAUNCH_GAME only carries the entry's `launchRef`.
 */
@Injectable()
export class GamesService {
  constructor(private readonly repo: GamesRepository) {}

  /** Gamers see enabled games only; staff+ see the whole catalog. */
  async list(caller: AccessTokenPayload) {
    const enabledOnly = SCOPE_RANK[caller.scope] < SCOPE_RANK.staff;
    return (await this.repo.list(enabledOnly)).map(toGameDto);
  }

  async create(dto: CreateGameDto) {
    await this.assertSlugFree(dto.slug);
    return toGameDto(await this.repo.create(dto));
  }

  async update(id: string, dto: UpdateGameDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw gameNotFound();
    if (dto.slug && dto.slug !== existing.slug) await this.assertSlugFree(dto.slug);
    return toGameDto(await this.repo.update(id, dto));
  }

  /**
   * LAUNCH_GAME pre-check, run before a command is created: the game must
   * exist (404) and be enabled (409).
   */
  async findLaunchable(id: string): Promise<Game> {
    const game = await this.repo.findById(id);
    if (!game) throw gameNotFound();
    if (!game.enabled) throw new ConflictException({ code: 'GAME_DISABLED', error: 'game is disabled' });
    return game;
  }

  private async assertSlugFree(slug: string): Promise<void> {
    if (await this.repo.findBySlug(slug)) {
      throw new ConflictException({ code: 'GAME_SLUG_TAKEN', error: 'slug already in use' });
    }
  }
}

function gameNotFound() {
  return new NotFoundException({ code: 'GAME_NOT_FOUND', error: 'game not found' });
}

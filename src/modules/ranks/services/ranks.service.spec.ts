import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '../../../generated/prisma/index.js';
import { RanksService } from './ranks.service.js';

const OLD_BADGE = '/uploads/images/3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34.webp';
const NEW_BADGE = '/uploads/images/a4e6b1d8-90c2-4f35-8b7a-2e5d1c6f9034.webp';
const gold = { id: 'r1', name: 'Gold', minXp: 4000, badgeUrl: OLD_BADGE };

const uniqueViolation = (target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test', meta: { target } });

describe('RanksService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let images: { release: ReturnType<typeof vi.fn> };
  let service: RanksService;

  beforeEach(() => {
    repo = {
      list: vi.fn(),
      find: vi.fn(async () => gold),
      create: vi.fn(),
      update: vi.fn(async (_id: string, dto: object) => ({ ...gold, ...dto })),
      delete: vi.fn(async () => gold),
    };
    images = { release: vi.fn() };
    service = new RanksService(repo as any, images as any);
  });

  it('hands the old badge to the image store once the new one is saved', async () => {
    const updated = await service.update('r1', { badgeUrl: NEW_BADGE });
    expect(updated).toMatchObject({ badgeUrl: NEW_BADGE });
    expect(images.release).toHaveBeenCalledWith(OLD_BADGE);
    expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(images.release.mock.invocationCallOrder[0]);
  });

  it('releases the badge of a deleted rank', async () => {
    await expect(service.remove('r1')).resolves.toEqual({ id: 'r1', deleted: true });
    expect(images.release).toHaveBeenCalledWith(OLD_BADGE);
  });

  it('404s an unknown rank, touching no image', async () => {
    repo.find.mockResolvedValue(null);
    await expect(service.update('nope', { name: 'X' })).rejects.toMatchObject({ response: { code: 'RANK_NOT_FOUND' } });
    await expect(service.remove('nope')).rejects.toMatchObject({ response: { code: 'RANK_NOT_FOUND' } });
    expect(images.release).not.toHaveBeenCalled();
  });

  it('tells a taken name from a taken XP', async () => {
    repo.create.mockRejectedValueOnce(uniqueViolation(['name']));
    await expect(service.create({ name: 'Gold', minXp: 1 })).rejects.toMatchObject({ response: { code: 'RANK_NAME_TAKEN' } });

    repo.create.mockRejectedValueOnce(uniqueViolation(['min_xp']));
    await expect(service.create({ name: 'Iron', minXp: 4000 })).rejects.toMatchObject({ response: { code: 'RANK_XP_TAKEN' } });
  });
});

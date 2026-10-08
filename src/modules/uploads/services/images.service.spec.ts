import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileOf } from '../util/image-files.js';
import { ImagesService } from './images.service.js';

const exists = (file: string) => access(file).then(() => true, () => false);

describe('ImagesService', () => {
  let root: string;
  let repo: { isUsed: ReturnType<typeof vi.fn> };
  let service: ImagesService;
  const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#2050c0' } }).png().toBuffer();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'images-service-'));
    repo = { isUsed: vi.fn(async () => false) };
    service = new ImagesService({ get: () => root } as any, repo as any);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('stores a picture in UPLOAD_DIR and answers its link', async () => {
    const url = await service.save(await png(), 'image');
    expect(await exists(fileOf(root, url)!)).toBe(true);
  });

  it('answers 400 IMAGE_UNSUPPORTED for anything but a picture', async () => {
    const refusal = service.save(Buffer.from('%PDF-1.7'), 'image');
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toMatchObject({ response: { code: 'IMAGE_UNSUPPORTED' } });
  });

  it('deletes a released file once no row uses it, and keeps it while one does', async () => {
    const kept = await service.save(await png(), 'image');
    const dropped = await service.save(await png(), 'image');
    repo.isUsed.mockImplementation(async (url: string) => url === kept);

    await service.release(kept, dropped);

    expect(await exists(fileOf(root, kept)!)).toBe(true);
    expect(await exists(fileOf(root, dropped)!)).toBe(false);
  });

  it('ignores empty, foreign and already deleted links, and never fails the request', async () => {
    const url = await service.save(await png(), 'image');
    await service.release(url);

    await expect(service.release(url, null, undefined, 'https://example.com/a.png', '/uploads/../.env')).resolves.toBeUndefined();
    expect(repo.isUsed).toHaveBeenCalledTimes(2); // only the two releases of our own link reached the database

    repo.isUsed.mockRejectedValueOnce(new Error('database down'));
    await expect(service.release(await service.save(await png(), 'image'))).resolves.toBeUndefined();
  });
});

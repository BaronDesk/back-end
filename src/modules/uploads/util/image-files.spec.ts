import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';

import { fileOf, toWebp, UnsupportedImageError, UPLOADED_IMAGE_URL, writeImage } from './image-files.js';

const picture = (width: number, height: number, format: 'png' | 'jpeg' | 'gif' = 'png') =>
  sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } })
    .toFormat(format)
    .toBuffer();

describe('toWebp', () => {
  it('fits a badge in 512×512 without enlarging it, as a WebP that keeps its transparency', async () => {
    const big = await sharp(await toWebp(await picture(2000, 1000), 'image')).metadata();
    expect(big).toMatchObject({ format: 'webp', width: 512, height: 256, hasAlpha: true });

    const small = await sharp(await toWebp(await picture(100, 80), 'image')).metadata();
    expect(small).toMatchObject({ width: 100, height: 80 });
  });

  it('crops an avatar to a 256×256 square', async () => {
    const avatar = await sharp(await toWebp(await picture(900, 600, 'jpeg'), 'avatar')).metadata();
    expect(avatar).toMatchObject({ format: 'webp', width: 256, height: 256 });
  });

  it("drops the picture's metadata (a phone photo's EXIF, GPS included)", async () => {
    const photo = await sharp(await picture(400, 300, 'jpeg'))
      .withExif({ IFD0: { Copyright: 'someone', Make: 'phone' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();

    expect((await sharp(await toWebp(photo, 'avatar')).metadata()).exif).toBeUndefined();
  });

  it('refuses what is not a PNG, JPEG or WebP picture, whatever its name', async () => {
    await expect(toWebp(await picture(10, 10, 'gif'), 'image')).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(toWebp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image')).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(toWebp(Buffer.from('not an image at all'), 'image')).rejects.toBeInstanceOf(UnsupportedImageError);
  });
});

describe('writeImage / fileOf', () => {
  let root: string;
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('writes the WebP under a random name and answers its link', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'images-'));
    const first = await writeImage(root, await picture(50, 50), 'image');
    const second = await writeImage(root, await picture(50, 50), 'image');

    expect(first).toMatch(UPLOADED_IMAGE_URL);
    expect(second).not.toBe(first);
    const file = fileOf(root, first)!;
    expect(file.startsWith(root)).toBe(true);
    expect((await sharp(await readFile(file)).metadata()).format).toBe('webp');

    expect(await writeImage(root, await picture(50, 50), 'avatar')).toMatch(/^\/uploads\/avatars\/[0-9a-f-]{36}\.webp$/);
  });

  it('maps only links this server wrote to a file', () => {
    expect(fileOf('/data', '/uploads/images/3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34.webp')).toBe(
      path.join('/data', 'images', '3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34.webp'),
    );
    for (const other of [
      'https://example.com/a.webp',
      '/uploads/../.env',
      '/uploads/images/../../.env',
      '/uploads/images/3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34.png',
      '/uploads/other/3f2b8c1e-7a4d-4e5b-9c61-0d2f8a9b1c34.webp',
    ]) {
      expect(fileOf('/data', other)).toBeNull();
    }
  });
});

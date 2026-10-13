import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

/**
 * Image files on disk. No Nest here: the seed uses it too.
 *
 * Every image is re-encoded, whatever was sent: checked by its content (not
 * by the name or the browser's type), resized, turned into WebP (transparency
 * kept) and stripped of its metadata (a phone photo's GPS position). The file
 * gets a random name, so a replaced image gets a new link and every link can
 * be cached forever.
 */

/** Where the files are served (main.ts → registerUploads). */
export const UPLOADS_PREFIX = '/uploads/';

/** Over this the upload is refused (413) before it is read in full. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Bigger pictures are refused before they are decoded (a small file can unpack to a huge image). */
const MAX_INPUT_PIXELS = 25_000_000;

const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

/**
 * - image: badges (tiers, passes, ranks) and game images. Fits in 512×512, never enlarged.
 * - avatar: profile pictures. Cropped to a 256×256 square.
 */
export const IMAGE_KINDS = {
  image: { folder: 'images', size: 512, fit: 'inside' },
  avatar: { folder: 'avatars', size: 256, fit: 'cover' },
} as const;
export type ImageKind = keyof typeof IMAGE_KINDS;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A link this server wrote, e.g. /uploads/images/<uuid>.webp. */
export const UPLOADED_FILE_PATTERN = new RegExp(`^/(images|avatars)/${UUID}\\.webp$`);
/** What a badgeUrl / iconUrl may hold: an image from POST /uploads/images. */
export const UPLOADED_IMAGE_URL = new RegExp(`^${UPLOADS_PREFIX}images/${UUID}\\.webp$`);

/** Not a PNG, JPEG or WebP picture, or too big to decode. */
export class UnsupportedImageError extends Error {}

/** Checks the picture and re-encodes it as WebP for its kind. */
export async function toWebp(input: Buffer, kind: ImageKind): Promise<Buffer> {
  const { size, fit } = IMAGE_KINDS[kind];
  try {
    const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS });
    const { format } = await image.metadata();
    if (!format || !ACCEPTED_FORMATS.has(format)) {
      throw new UnsupportedImageError(`${format ?? 'unknown'} images are not accepted`);
    }
    return await image
      .rotate() // a phone photo stands the way it was taken, before its orientation tag is dropped
      .resize(size, size, { fit, withoutEnlargement: fit === 'inside' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (error) {
    if (error instanceof UnsupportedImageError) throw error;
    // sharp could not read it: not an image, a broken one, or over the pixel limit
    throw new UnsupportedImageError(error instanceof Error ? error.message : String(error));
  }
}

/** Re-encodes the picture, writes it under `root` and returns its link. */
export async function writeImage(root: string, input: Buffer, kind: ImageKind): Promise<string> {
  const data = await toWebp(input, kind);
  const folder = IMAGE_KINDS[kind].folder;
  const name = `${randomUUID()}.webp`;
  await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, folder, name), data, { flag: 'wx' });
  return `${UPLOADS_PREFIX}${folder}/${name}`;
}

/** The file behind a link this server wrote, or null for any other text. */
export function fileOf(root: string, url: string): string | null {
  if (!url.startsWith(UPLOADS_PREFIX)) return null;
  const rest = url.slice(UPLOADS_PREFIX.length - 1);
  if (!UPLOADED_FILE_PATTERN.test(rest)) return null;
  return path.join(root, ...rest.split('/').filter(Boolean));
}

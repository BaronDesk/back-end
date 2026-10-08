import { unlink } from 'node:fs/promises';
import path from 'node:path';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ImagesRepository } from '../repository/images.repository.js';
import { fileOf, UnsupportedImageError, writeImage, type ImageKind } from '../util/image-files.js';

/**
 * The uploaded images: badges of membership tiers, passes and ranks, game
 * images and gamer avatars. The files sit in UPLOAD_DIR; the database keeps
 * only their links. Every file operation goes through here, so another store
 * (S3, MinIO) would replace this class only.
 */
@Injectable()
export class ImagesService {
  private readonly logger = new Logger(ImagesService.name);
  readonly root: string;

  constructor(
    config: ConfigService,
    private readonly repo: ImagesRepository,
  ) {
    this.root = path.resolve(config.get<string>('UPLOAD_DIR') ?? 'uploads');
  }

  /** Stores the picture and returns its link. 400 IMAGE_UNSUPPORTED if it is not a PNG, JPEG or WebP. */
  async save(input: Buffer, kind: ImageKind): Promise<string> {
    try {
      return await writeImage(this.root, input, kind);
    } catch (error) {
      if (error instanceof UnsupportedImageError) {
        throw new BadRequestException({ code: 'IMAGE_UNSUPPORTED', error: 'send a PNG, JPEG or WebP picture' });
      }
      throw error;
    }
  }

  /**
   * Deletes the files behind these links once no row uses them any more.
   * Called after a row's image changed or the row was deleted, with its old
   * link: a link still in use (unchanged, or shared by another row) stays.
   * Never fails the request: a file left behind is only disk space.
   */
  async release(...urls: (string | null | undefined)[]): Promise<void> {
    for (const url of new Set(urls)) {
      const file = url ? fileOf(this.root, url) : null;
      if (!file) continue;
      try {
        if (await this.repo.isUsed(url!)) continue;
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.logger.warn(`could not delete ${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

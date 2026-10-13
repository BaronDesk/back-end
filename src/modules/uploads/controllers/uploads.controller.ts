import { Controller, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, type ApiBodyOptions } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ImagesService } from '../services/images.service.js';
import { readUpload } from '../util/read-upload.js';

/** The multipart body every upload route takes (Swagger). */
export const IMAGE_UPLOAD_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary', description: 'PNG, JPEG or WebP, at most 2 MB' } },
  },
};

@Controller('uploads')
export class UploadsController {
  constructor(private readonly images: ImagesService) {}

  /**
   * Stores a badge or game image and answers its link. Save that link as the
   * `badgeUrl` of a membership tier, pass or rank, or the `iconUrl` of a
   * game. It fits in 512×512 and is stored as WebP (transparency kept).
   */
  @RequireScope('admin')
  @Post('images')
  @ApiConsumes('multipart/form-data')
  @ApiBody(IMAGE_UPLOAD_BODY)
  async uploadImage(@Req() req: FastifyRequest) {
    return { url: await this.images.save(await readUpload(req), 'image') };
  }
}

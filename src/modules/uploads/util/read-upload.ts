import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import type {} from '@fastify/multipart'; // req.isMultipart() / req.file()
import type { FastifyRequest } from 'fastify';

import { MAX_IMAGE_BYTES } from './image-files.js';

const imageRequired = () =>
  new BadRequestException({ code: 'IMAGE_REQUIRED', error: 'send one picture as multipart/form-data, in a "file" field' });

/** The one file of a multipart upload, read in memory (at most MAX_IMAGE_BYTES). */
export async function readUpload(req: FastifyRequest): Promise<Buffer> {
  if (!req.isMultipart()) throw imageRequired();
  try {
    const part = await req.file();
    if (!part) throw imageRequired();
    return await part.toBuffer();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new PayloadTooLargeException({ code: 'IMAGE_TOO_LARGE', error: `the picture must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` });
    }
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') throw imageRequired();
    throw error;
  }
}

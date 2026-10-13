import { mkdir } from 'node:fs/promises';

import fastifyMultipart, { type FastifyMultipartOptions } from '@fastify/multipart';
import fastifyStatic, { type FastifyStaticOptions } from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ImagesService } from './services/images.service.js';
import { MAX_IMAGE_BYTES, UPLOADED_FILE_PATTERN, UPLOADS_PREFIX } from './util/image-files.js';

// @nestjs/platform-fastify ships its own copy of fastify, whose types differ
// from the root one the plugins are typed against; the plugins run on either.
type NestPlugin = Parameters<NestFastifyApplication['register']>[0];

/**
 * Turns uploads on: multipart bodies (one file, at most MAX_IMAGE_BYTES) and
 * GET /uploads/<folder>/<uuid>.webp, public and cached for a year (a file
 * never changes: a new image gets a new name). Call it before app.init() or
 * listen(), like any Fastify plugin: main.ts, and specs that upload.
 */
export async function registerUploads(app: NestFastifyApplication): Promise<void> {
  const { root } = app.get(ImagesService);
  await mkdir(root, { recursive: true });

  const multipart: FastifyMultipartOptions = {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 11 },
  };
  await app.register(fastifyMultipart as unknown as NestPlugin, multipart);

  const files: FastifyStaticOptions = {
    root,
    prefix: UPLOADS_PREFIX,
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: 'deny',
    immutable: true,
    maxAge: '365d',
    // Only files this server wrote (a stray file dropped in the folder is not served).
    allowedPath: (pathName) => UPLOADED_FILE_PATTERN.test(pathName),
    setHeaders: (reply) => reply.header('X-Content-Type-Options', 'nosniff'),
  };
  await app.register(fastifyStatic as unknown as NestPlugin, files);
}

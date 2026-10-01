import 'reflect-metadata';

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { buildOpenApiDocument } from './common/swagger/build-document.js';

/**
 * Writes the OpenAPI spec to a file without a database or Redis: `preview`
 * builds the module graph but instantiates no providers. Used for the static docs.
 *
 *   node dist/export-openapi.js [out=docs/openapi.json] [serverUrl]
 */
async function main() {
  const out = resolve(process.argv[2] ?? 'docs/openapi.json');
  const serverUrl = process.argv[3];

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    preview: true,
    abortOnError: false,
    logger: false,
  });

  const doc = buildOpenApiDocument(app, serverUrl);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out} (${Object.keys(doc.paths).length} paths)`);
  await app.close();
}

void main();

import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

import { enrichDocumentFromZod } from './zod-openapi.js';

const DESCRIPTION = `REST API of the gaming-cafe platform: accounts, bookings, PIN check-in, sessions, billing and wallet.

**Flow to try**
1. \`POST /users\` create a gamer (or use a seeded account), then \`POST /auth/login\`.
2. Copy \`accessToken\`, click **Authorize**, paste it (no "Bearer " prefix).
3. \`GET /machines\` or \`GET /branches/{id}/stations\` pick a machine.
4. \`POST /reservations\` book it, the answer holds the station PIN.
5. Staff top up with \`POST /wallets/{gamerProfileId}/credit\`; sessions are billed from the wallet.

Errors always have the shape \`{ error, code, issues? }\`. Money is an integer in the smallest unit.`;

export function buildOpenApiDocument(app: INestApplication, serverUrl?: string): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('cstam backend')
    .setDescription(DESCRIPTION)
    .setVersion('0.1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer');
  if (serverUrl) builder.addServer(serverUrl);

  const doc = SwaggerModule.createDocument(app, builder.build(), {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
  });
  return enrichDocumentFromZod(app, doc);
}

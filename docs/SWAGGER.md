# API docs (Swagger / OpenAPI)

The backend describes its REST API as an OpenAPI document. There are two ways to read it.

## 1. Live Swagger UI

Available when the backend runs with `NODE_ENV` other than `production` (the dev stack does).

| URL | what |
|:---|:---|
| `http://localhost:3000/docs` | Swagger UI, "Try it out" works against the running backend |
| `http://localhost:3000/docs-json` | the raw OpenAPI JSON |

Trying a request:

1. `POST /users` to create a gamer (or use a seeded account, see the README), then `POST /auth/login`.
2. Copy `accessToken`, click **Authorize**, paste it **without** the `Bearer ` prefix.
3. `GET /machines` or `GET /branches/{id}/stations` to pick a machine.
4. `POST /reservations` to book it; the answer holds the station PIN.
5. Staff top up with `POST /wallets/{gamerProfileId}/credit`; sessions are billed from the wallet.

Conventions:

* Errors always have the shape `{ error, code, issues? }`.
* Money is whole coins, the platform's own unit (in Tunisia 1000 coins = 1 DT). Play prices are coins per hour, the same in every branch (`GET /pricing`).
* Auth is a JWT bearer token (security scheme `bearer`).

## 2. Static docs (no backend needed)

The `docs/` folder holds a read-only Swagger UI with the spec inlined:

| file | what |
|:---|:---|
| `docs/index.html` | the page. Open it from disk or host the folder on any static server |
| `docs/openapi.json` | the exported spec, also importable into Postman or Insomnia |
| `docs/swagger-ui.css`, `docs/swagger-ui-bundle.js` | UI assets copied beside the page so it works offline |

Regenerate after the API changes:

```bash
npm run docs:build     # runs docs:export, then builds index.html
npm run docs:export    # only rewrites docs/openapi.json
```

`docs:export` builds the Nest module graph in preview mode (no providers are created), so it needs neither Postgres nor Redis. To write the spec elsewhere or set a server URL:

```bash
npm run build
node dist/export-openapi.js <out-file> [serverUrl]
```

## How the spec is built

* [src/common/swagger/build-document.ts](../src/common/swagger/build-document.ts) sets the title, description, bearer auth and operation ids (`Controller_method`). Both the live UI ([src/main.ts](../src/main.ts)) and the exporter ([src/export-openapi.ts](../src/export-openapi.ts)) use it.
* [src/common/swagger/zod-openapi.ts](../src/common/swagger/zod-openapi.ts) turns the Zod request schemas used by the controllers into OpenAPI schemas.
* [src/common/swagger/response-examples.ts](../src/common/swagger/response-examples.ts) holds the response examples.

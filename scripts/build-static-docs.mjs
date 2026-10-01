// Builds docs/index.html: a read-only Swagger UI with the spec inlined and the
// UI assets copied beside it, so the folder works offline, from file:// or any static host.
//
//   npm run docs:build        (exports the spec first, then runs this)
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
const ui = join(root, 'node_modules', 'swagger-ui-dist');

const spec = JSON.parse(await readFile(join(docs, 'openapi.json'), 'utf8'));
for (const file of ['swagger-ui.css', 'swagger-ui-bundle.js']) await copyFile(join(ui, file), join(docs, file));

// `</script>` inside the JSON would end the tag early.
const inline = JSON.stringify(spec).replace(/</g, '\u003c');

await writeFile(
  join(docs, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${spec.info.title} API</title>
  <link rel="stylesheet" href="swagger-ui.css">
  <style>
    body { margin: 0; }
    .banner { background: #1f2937; color: #e5e7eb; padding: 10px 20px; font: 14px system-ui, sans-serif; }
  </style>
</head>
<body>
  <div class="banner">Static documentation: every endpoint, request body and example response. Requests cannot be sent from this page.</div>
  <div id="ui"></div>
  <script src="swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      spec: ${inline},
      dom_id: '#ui',
      docExpansion: 'list',
      defaultModelsExpandDepth: 0,
      supportedSubmitMethods: [],
    });
  </script>
</body>
</html>
`,
);
console.log('wrote docs/index.html');

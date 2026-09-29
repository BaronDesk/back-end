#!/usr/bin/env node
/**
 * Serves the physical-test observer page and proxies everything else to the
 * backend, so the page, the REST calls and the /dashboard-io socket share one
 * origin (the backend enables no CORS). THROWAWAY TEST TOOLING.
 *
 *   node tools/physical-test/serve-observer.mjs
 *   open http://localhost:8080
 *
 * PT_BACKEND        backend to proxy to (default http://127.0.0.1:3000, the dev compose port)
 * PT_OBSERVER_PORT  default 8080
 * PT_OBSERVER_HOST  default 127.0.0.1. Set 0.0.0.0 to let other PCs in the room open
 *                   it (plain HTTP on the LAN: test networks only).
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = new URL(process.env.PT_BACKEND ?? 'http://127.0.0.1:3000');
const PORT = Number(process.env.PT_OBSERVER_PORT ?? 8080);
const HOST = process.env.PT_OBSERVER_HOST ?? '127.0.0.1';

const STATIC = {
  '/': [join(HERE, 'observer', 'index.html'), 'text/html; charset=utf-8'],
  '/pt/config.json': [join(HERE, 'out', 'observer-config.json'), 'application/json'],
  '/pt/socket.io.min.js': [join(HERE, '..', '..', 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js'), 'text/javascript'],
};

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const file = STATIC[path];
  if (file) {
    if (!existsSync(file[0])) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(path === '/pt/config.json' ? 'run the seed first (RUNBOOK §1.3)' : `missing ${file[0]}`);
      return;
    }
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    createReadStream(file[0]).pipe(res);
    return;
  }

  const upstream = request(
    { hostname: BACKEND.hostname, port: BACKEND.port, method: req.method, path: req.url, headers: { ...req.headers, host: BACKEND.host } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'BACKEND_UNREACHABLE', error: err.message }));
  });
  req.pipe(upstream);
});

// WebSocket upgrade (socket.io on /dashboard-io): replay the request head, then pipe raw bytes.
server.on('upgrade', (req, socket, head) => {
  const upstream = connect(Number(BACKEND.port || 80), BACKEND.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: BACKEND.host })
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket).pipe(upstream);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
});

server.listen(PORT, HOST, () => {
  console.log(`PT observer: http://${HOST === '0.0.0.0' ? '<this-pc-ip>' : HOST}:${PORT}  (proxying ${BACKEND.origin})`);
});

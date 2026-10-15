#!/usr/bin/env node
/**
 * Restarts the dev backend container while stations are connected, to test
 * (or demo) what a backend restart does to running sessions.
 *
 *   node scripts/restart-backend.mjs [--graceful] [--down <seconds>] [--url <health url>]
 *
 * Default: a crash. The container gets SIGKILL, so no socket is closed and no
 * presence state is written: stations find out by losing their connection.
 * --graceful stops it with SIGTERM instead (Nest shuts down cleanly).
 * --down: how long the backend stays down before it is started again
 * (default 30; more than the station lease, 60 s by default, locks the PCs).
 *
 * Uses the same compose files as `npm run dc`; the files are not changed.
 * Development only.
 */
import { spawnSync } from 'node:child_process';

const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml'];

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const graceful = args.includes('--graceful');
const downSeconds = Number(option('--down', '30'));
const healthUrl = option('--url', 'http://localhost:3000/health');
if (!Number.isFinite(downSeconds) || downSeconds < 0) {
  console.error('--down must be a number of seconds');
  process.exit(1);
}

function docker(...rest) {
  const result = spawnSync('docker', [...COMPOSE, ...rest], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`docker ${[...COMPOSE, ...rest].join(' ')} failed:\n${result.stderr || result.stdout}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

/** Stations the database shows ONLINE (as the backend last wrote it). */
function onlineStations() {
  const sql = "select serial_number || ' (last seen ' || to_char(last_seen, 'HH24:MI:SS') || ')' from machines where status = 'ONLINE' order by serial_number";
  const out = docker('exec', '-T', 'postgres', 'sh', '-c', `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "${sql}"`);
  return out ? out.split('\n') : [];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(healthUrl)).ok) return true;
    } catch {
      // not listening yet
    }
    await sleep(1_000);
  }
  return false;
}

const before = onlineStations();
console.log(`[${stamp()}] ${before.length} station(s) ONLINE:${before.map((s) => `\n  - ${s}`).join('')}`);
if (!before.length) console.warn('  warning: no station is connected, so the restart affects no session');

if (graceful) {
  console.log(`[${stamp()}] stopping backend (SIGTERM)`);
  docker('stop', '-t', '10', 'backend');
} else {
  console.log(`[${stamp()}] killing backend (SIGKILL): a crash, nothing is closed cleanly`);
  docker('kill', '-s', 'SIGKILL', 'backend');
}

console.log(`[${stamp()}] backend down for ${downSeconds}s`);
await sleep(downSeconds * 1000);

console.log(`[${stamp()}] starting backend`);
docker('start', 'backend');
const started = Date.now();
if (!(await waitHealthy(120_000))) {
  console.error(`[${stamp()}] backend not healthy at ${healthUrl} after 120 s: check \`npm run docker:logs\``);
  process.exit(1);
}
console.log(`[${stamp()}] backend healthy after ${Math.round((Date.now() - started) / 1000)}s`);
console.log('  stations reconnect on their own; stale rows go OFFLINE at the first watchdog pass.');
console.log('  follow it with: npm run docker:logs');

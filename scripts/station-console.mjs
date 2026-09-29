#!/usr/bin/env node
/**
 * Station console: an interactive "server operator" for the physical test of
 * the BaronDesk desktop agent. It logs in as staff, picks one station, and
 * lets you issue every remote command, manage the game catalog, read
 * telemetry and alerts, and run the whole gamer flow (users, pricing, wallet,
 * membership/subscription plans, reservation, session start with PIN,
 * metering, end and settlement), while it prints the live /dashboard-io feed.
 *
 * Test plan: docs/STATION_PHYSICAL_TEST.md
 *
 * Usage (from the repo root, stack up):
 *   node scripts/station-console.mjs
 *
 * Reservations have no REST route yet: the console inserts them with psql
 * through `docker compose exec postgres` (so run it from the repo root).
 *
 * Environment (all optional):
 *   BASE_URL        default http://localhost:3000 (Nest directly, no TLS)
 *   CONSOLE_USER    default hq-admin
 *   CONSOLE_PASS    default change-me-immediately
 *   STATION_SERIAL  preselect a station by serial number
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { io } from 'socket.io-client';
import { WebSocket } from 'ws';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const USERNAME = process.env.CONSOLE_USER ?? 'hq-admin';
const PASSWORD = process.env.CONSOLE_PASS ?? 'change-me-immediately';

const TERMINAL_STATUSES = new Set(['ACKED', 'NACKED', 'FAILED', 'TIMEOUT']);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, def) => {
  const answer = (await rl.question(def !== undefined ? `${q} ${c.dim(`[${def}]`)}: ` : `${q}: `)).trim();
  return answer === '' && def !== undefined ? String(def) : answer;
};
const confirm = async (q) => /^y(es)?$/i.test(await ask(`${q} (y/N)`, 'N'));

const state = {
  accessToken: null,
  refreshToken: null,
  station: null,
  branchId: null,
  /** Second login, for the gamer-side calls (wallet/me, plan purchases). */
  gamer: null,
  /** Last session started from the console. */
  session: null,
  feed: { telemetry: false, status: true, commands: true, catalog: true, alerts: true },
};

function log(...args) {
  // Keep feed lines from landing in the middle of a prompt.
  stdout.write('\r\x1b[K');
  console.log(...args);
}

// ---------------------------------------------------------------- who may see what
//
// Mirrors the backend's policy (src/common/utils/scope.ts and each route's
// @RequireScope): GAMER = self, EMPLOYEE = staff, MANAGER = admin, ADMIN = hq.
// A menu only lists what the logged-in profile is allowed to do, so a gamer
// never sees "create employee" and an employee never sees "SHUTDOWN".
// The server still enforces it: to test a 403 on purpose, use raw request (r).

const ROLE_SCOPE = { GAMER: 'self', EMPLOYEE: 'staff', MANAGER: 'admin', ADMIN: 'hq' };
const SCOPE_RANK = { self: 1, staff: 2, admin: 3, hq: 4 };

const scope = () => ROLE_SCOPE[state.me?.role] ?? 'self';
const can = (min) => SCOPE_RANK[scope()] >= SCOPE_RANK[min];
const isGamerConsole = () => state.me?.role === 'GAMER';

/**
 * Menu of `items` ({ key, label, min, when, run } or { section }). Only the
 * items the profile may use are listed, and only those keys are accepted.
 */
async function menu(title, items, { root = false } = {}) {
  for (;;) {
    const visible = items.filter((i) => (!i.min || can(i.min)) && (!i.when || i.when()));
    // Drop section headers with nothing under them.
    const shown = visible.filter((i, n) => !i.section || (visible[n + 1] && !visible[n + 1].section));
    log(`\n${c.bold(typeof title === 'function' ? title() : title)}`);
    for (const i of shown) log(i.section ? c.dim(`  -- ${i.section}`) : `  ${i.key.padEnd(2)} ${typeof i.label === 'function' ? i.label() : i.label}`);
    log(root ? '  q  quit' : '  0  back');
    const choice = (await ask('>')).toLowerCase();
    if (root ? choice === 'q' : choice === '0' || choice === '') return;
    const item = shown.find((i) => i.key === choice);
    if (!item) continue;
    try {
      await item.run();
    } catch (err) {
      log(c.red(`error: ${err.message}`));
    }
  }
}

// ---------------------------------------------------------------- HTTP

/** `as: 'gamer'` sends the request with the gamer login (see gamerLogin) instead of the staff one. */
async function http(method, path, body, { quiet = false, retried = false, as = 'staff' } = {}) {
  const token = as === 'gamer' ? state.gamer?.accessToken : state.accessToken;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (as === 'staff' && state.refreshToken) {
      await refresh();
      return http(method, path, body, { quiet, as, retried: true });
    }
    if (as === 'gamer' && state.gamer) {
      await gamerLogin(state.gamer.username, state.gamer.password);
      return http(method, path, body, { quiet, as, retried: true });
    }
  }
  if (!quiet) {
    const tag = res.ok ? c.green(`${res.status}`) : c.red(`${res.status}`);
    log(`${c.dim(`${as === 'gamer' ? `[as ${state.gamer?.username}] ` : ''}${method} ${path}`)} -> ${tag}`);
    if (!res.ok) log(c.red(JSON.stringify(data, null, 2)));
  }
  return { status: res.status, ok: res.ok, data };
}

async function login() {
  const res = await http('POST', '/auth/login', { username: USERNAME, password: PASSWORD });
  if (!res.ok) throw new Error(`login failed for ${USERNAME}`);
  state.accessToken = res.data.accessToken;
  state.refreshToken = res.data.refreshToken;
  const me = await http('GET', '/auth/me', undefined, { quiet: true });
  state.me = me.data;
  log(c.green(`logged in as ${USERNAME}: ${state.me?.role} (scope ${scope()}${state.me?.branchId ? `, branch ${state.me.branchId}` : ''})`));
  if (state.me?.branchId) state.branchId = state.me.branchId;
  // A gamer console acts as that gamer: the gamer-side calls use its own token.
  if (isGamerConsole()) {
    state.gamer = { username: USERNAME, password: PASSWORD, accessToken: state.accessToken, gamerProfileId: null };
    const wallet = await http('GET', '/wallets/me', undefined, { as: 'gamer', quiet: true });
    if (wallet.ok) state.gamer.gamerProfileId = wallet.data.gamerProfileId;
  }
}

async function refresh() {
  const res = await http('POST', '/auth/refresh', { refreshToken: state.refreshToken }, { quiet: true });
  if (!res.ok) return login();
  state.accessToken = res.data.accessToken;
  state.refreshToken = res.data.refreshToken;
  connectFeed(); // the socket keeps the old token for reconnects otherwise
}

// ---------------------------------------------------------------- live feed

let socket;

function connectFeed() {
  socket?.close();
  socket = io(BASE_URL, { path: '/dashboard-io', auth: { token: state.accessToken }, transports: ['websocket'] });
  socket.on('connect', () => log(c.dim('[feed] connected to /dashboard-io')));
  socket.on('connect_error', (err) => log(c.red(`[feed] connect error: ${err.message}`)));
  socket.on('disconnect', (reason) => log(c.yellow(`[feed] disconnected: ${reason}`)));

  // Only this station's events. An event that names no station is shown.
  const mine = (p) => {
    if (!state.station || !p) return true;
    if (p.serialNumber) return p.serialNumber === state.station.serialNumber;
    const id = p.machineId ?? p.stationId;
    return !id || id === state.station.id;
  };

  socket.on('station_status', (p) => {
    if (!mine(p)) return;
    if (p.branchId) state.branchId ??= p.branchId;
    if (state.feed.status) log(c.cyan('[station_status]'), JSON.stringify(p));
  });
  socket.on('command_update', (p) => {
    if (!state.feed.commands || !mine(p)) return;
    const color = p.status === 'ACKED' ? c.green : TERMINAL_STATUSES.has(p.status) ? c.red : c.yellow;
    const extra = [p.nackCode, p.nackReason, p.failureReason].filter(Boolean).join(' | ');
    log(color(`[command_update] ${p.type} ${p.status} attempts=${p.attempts}`), c.dim(`${p.commandId} ${extra}`));
    if (p.branchId) state.branchId ??= p.branchId;
  });
  socket.on('catalog_status', (p) => {
    if (state.feed.catalog && mine(p)) log(c.cyan('[catalog_status]'), JSON.stringify(p));
  });
  socket.on('telemetry_update', (p) => {
    if (state.feed.telemetry && mine(p)) log(c.dim('[telemetry_update]'), JSON.stringify(p));
  });
  socket.on('alert', (p) => {
    if (state.feed.alerts && mine(p)) log(c.red('[alert]'), JSON.stringify(p));
  });
  socket.on('alert_resolved', (p) => {
    if (state.feed.alerts && mine(p)) log(c.green('[alert_resolved]'), JSON.stringify(p));
  });
}

// ---------------------------------------------------------------- stations

async function pickStation() {
  const res = await http('GET', '/api/v1/stations');
  if (!res.ok) return;
  const stations = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (stations.length === 0) {
    log(c.yellow('no stations yet: enroll one (e, 1)'));
    return;
  }
  stations.forEach((s, i) =>
    log(`  ${i + 1}. ${s.serialNumber.padEnd(20)} ${s.status.padEnd(8)} locked=${s.locked} session=${s.sessionId ?? '-'} ${c.dim(s.id)}`),
  );
  const preset = stations.findIndex((s) => s.serialNumber === process.env.STATION_SERIAL);
  const n = Number(await ask('station #', preset >= 0 ? preset + 1 : 1));
  state.station = stations[n - 1] ?? stations[0];
  log(c.bold(`station: ${state.station.serialNumber} (${state.station.id})`));
}

async function showStation() {
  const res = await http('GET', `/api/v1/stations/${state.station.id}`);
  if (res.ok) {
    state.station = res.data;
    console.table([res.data]);
  }
}

// ---------------------------------------------------------------- commands

async function issue(body) {
  const res = await http('POST', `/api/v1/stations/${state.station.id}/commands`, body);
  if (!res.ok) return res;
  const { commandId } = res.data;
  if (res.data.branchId) state.branchId ??= res.data.branchId;
  log(c.dim(`queued ${body.type} ${commandId}, waiting for a final status...`));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const cmd = await http('GET', `/api/v1/commands/${commandId}`, undefined, { quiet: true });
    if (cmd.ok && TERMINAL_STATUSES.has(cmd.data.status)) {
      const color = cmd.data.status === 'ACKED' ? c.green : c.red;
      log(color(c.bold(`=> ${body.type}: ${cmd.data.status}`)), c.dim(JSON.stringify(cmd.data)));
      return cmd;
    }
  }
  log(c.yellow('no final status after 60 s'));
  return res;
}

async function unlockBooking() {
  const sessionId = await ask('sessionId', randomUUID());
  const pin = await ask('PIN the player types on the LockUI', '4821');
  return issue({ type: 'UNLOCK', payload: { sessionId, pin } });
}

async function launchGame() {
  await stationCatalog();
  const gameId = await ask('gameId (wire id)', 'notepad');
  return issue({ type: 'LAUNCH_GAME', gameId });
}

async function endSession() {
  const reason = await ask('reason (empty = agent default "normal")', '');
  return issue(reason ? { type: 'END_SESSION', reason } : { type: 'END_SESSION' });
}

async function shutdown() {
  if (!(await confirm('SHUTDOWN the station?'))) return;
  return issue({ type: 'SHUTDOWN' });
}

async function simulate() {
  log(`  1. stale_ts         expect NACKED  (STALE)
  2. duplicate_send   expect ACKED   (agent runs once, re-acks the duplicate)
  3. invalid_payload  expect FAILED  (INVALID_PAYLOAD)
  4. exec_failed      expect FAILED  (EXEC_FAILED)`);
  const sims = ['stale_ts', 'duplicate_send', 'invalid_payload', 'exec_failed'];
  const sim = sims[Number(await ask('simulation #', 1)) - 1];
  if (!sim) return;
  const type = (await ask('command type (wire type is LAUNCH_GAME for 3 and 4 anyway)', 'LOCK')).toUpperCase();
  const body = { type, simulate: sim };
  if (type === 'LAUNCH_GAME') body.gameId = await ask('gameId', 'notepad');
  return issue(body);
}

async function listCommands() {
  const limit = await ask('limit', 10);
  const res = await http('GET', `/api/v1/stations/${state.station.id}/commands?limit=${limit}`);
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (res.ok)
    console.table(
      rows.map((r) => ({
        type: r.type,
        status: r.status,
        attempts: r.attempts,
        gameId: r.gameId ?? '',
        nack: [r.nackCode, r.nackReason].filter(Boolean).join(': '),
        failure: r.failureReason ?? '',
        issuedAt: r.issuedAt,
      })),
    );
}

// ---------------------------------------------------------------- games

async function listGames() {
  const res = await http('GET', '/api/v1/games');
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (res.ok)
    console.table(
      rows.map((g) => ({ id: g.id, gameId: g.gameId, name: g.name, type: g.launchType, target: g.target, enabled: g.enabled })),
    );
  return rows;
}

async function stationCatalog() {
  const res = await http('GET', `/api/v1/stations/${state.station.id}/games`);
  if (res.ok) console.dir(res.data, { depth: 5 });
}

async function createGame() {
  const launchType = await ask('launchType exe|steam|epic', 'exe');
  const defaults = {
    exe: { gameId: 'notepad', name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe', processName: 'notepad.exe' },
    steam: { gameId: 'cs2', name: 'Counter-Strike 2', target: '730', processName: 'cs2.exe' },
    epic: { gameId: 'fortnite', name: 'Fortnite', target: 'Fortnite', processName: 'FortniteClient-Win64-Shipping.exe' },
  }[launchType] ?? {};
  const body = {
    launchType,
    gameId: await ask('gameId (wire id)', defaults.gameId),
    name: await ask('name', defaults.name),
    target: await ask('target', defaults.target),
  };
  const processName = await ask('processName (empty = none)', defaults.processName ?? '');
  if (processName) body.processName = processName;
  if (launchType !== 'epic') {
    const args = await ask('arguments (empty = none)', '');
    if (args) body.arguments = args;
  }
  const res = await http('POST', '/api/v1/games', body);
  if (res.ok) log(c.green(`created ${res.data.gameId} id=${res.data.id}`));
}

async function pickGame() {
  const games = await listGames();
  const key = await ask('game (uuid or wire gameId)');
  return games.find((g) => g.id === key || g.gameId === key)?.id ?? key;
}

async function assignStation() {
  const id = await pickGame();
  const body = {};
  const target = await ask('override target (empty = keep game value)', '');
  if (target) body.target = target;
  const args = await ask('override arguments (empty = keep)', '');
  if (args) body.arguments = args;
  await http('PUT', `/api/v1/games/${id}/stations/${state.station.id}`, body);
}

async function unassignStation() {
  const id = await pickGame();
  await http('DELETE', `/api/v1/games/${id}/stations/${state.station.id}`);
}

async function branchAssignment(method) {
  const id = await pickGame();
  const branchId = await ask('branchId (from command_update, or SELECT branch_id FROM machines)', state.branchId ?? '');
  await http(method, `/api/v1/games/${id}/branches/${branchId}`);
}

async function toggleGame() {
  const id = await pickGame();
  const enabled = (await ask('enabled true|false', 'false')) === 'true';
  await http('PATCH', `/api/v1/games/${id}`, { enabled });
}

async function editGame() {
  const id = await pickGame();
  const field = await ask('field (name|target|arguments|workingDirectory|processName|gameId|sortOrder)', 'target');
  let value = await ask('new value (null to clear)');
  if (value === 'null') value = null;
  else if (field === 'sortOrder') value = Number(value);
  await http('PATCH', `/api/v1/games/${id}`, { [field]: value });
}

function gamesMenu() {
  return menu('Games', [
    { key: '1', label: 'list global catalog', min: 'self', run: listGames },
    { key: '2', label: 'station catalog + catalog_status', min: 'staff', when: () => !!state.station, run: stationCatalog },
    { section: 'manage (manager / admin)' },
    { key: '3', label: 'create game', min: 'admin', run: createGame },
    { key: '4', label: 'assign to this station', min: 'admin', when: () => !!state.station, run: assignStation },
    { key: '5', label: 'unassign from this station', min: 'admin', when: () => !!state.station, run: unassignStation },
    { key: '6', label: 'assign to branch', min: 'admin', run: () => branchAssignment('PUT') },
    { key: '7', label: 'unassign from branch', min: 'admin', run: () => branchAssignment('DELETE') },
    { key: '8', label: 'enable / disable game', min: 'admin', run: toggleGame },
    { key: '9', label: 'edit game field', min: 'admin', run: editGame },
  ]);
}

// ---------------------------------------------------------------- telemetry / alerts

async function telemetry() {
  const res = await http('GET', `/api/v1/stations/${state.station.id}/telemetry`);
  if (res.ok) console.dir(res.data, { depth: 5 });
}

async function alerts() {
  const status = await ask('status open|resolved|all', 'open');
  const res = await http('GET', `/api/v1/alerts?limit=20${status === 'all' ? '' : `&status=${status}`}`);
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (res.ok) console.dir(rows, { depth: 4 });
  const id = await ask('alert id to resolve (empty = none)', '');
  if (id) await http('POST', `/api/v1/alerts/${id}/resolve`);
}

// ---------------------------------------------------------------- database (psql in the postgres container)

const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml'];

/** Runs SQL through `docker compose exec postgres psql`. Returns rows as arrays of strings, or null on failure. */
function psql(sql, { quiet = false } = {}) {
  try {
    const out = execFileSync(
      'docker',
      [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'cstam', '-d', 'cstam', '-qAt', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (!quiet) log(c.dim(`psql: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`));
    return out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split('|').map((field) => field.trim()));
  } catch (err) {
    log(c.red(`psql failed (run from the repo root, stack up): ${(err.stderr || err.message).trim()}`));
    log(c.yellow(`run it yourself with npm run db:psql:\n${sql}`));
    return null;
  }
}

async function branchId() {
  if (!state.branchId && state.station) {
    state.branchId = psql(`SELECT branch_id FROM machines WHERE id = '${state.station.id}'`, { quiet: true })?.[0]?.[0] ?? null;
  }
  return state.branchId ?? ask('branchId');
}

// ---------------------------------------------------------------- enrollment stand-in
//
// Enrollment (POST /enrollment/request, docs/ENROLLMENT_HANDOFF.md) is not
// built on this branch. Like the old scripts/node-monitor.ts, the console
// writes what enrollment would leave behind: an ENROLLED MACHINE row and a
// station JWT signed with the backend's JWT_ACCESS_SECRET. Then it runs the
// admission cases against /agent-ws and GET /stations/me/games.

const ENROLLMENT_STATUSES = ['PENDING', 'ENROLLED', 'INACTIVE', 'DEACTIVATED'];
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/agent-ws`;

/** JWT_ACCESS_SECRET as the backend container sees it, else from ./.env. */
function accessSecret() {
  if (state.secret) return state.secret;
  try {
    state.secret = execFileSync('docker', [...COMPOSE, 'exec', '-T', 'backend', 'printenv', 'JWT_ACCESS_SECRET'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    const line = existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith('JWT_ACCESS_SECRET=')) : undefined;
    state.secret = line?.slice('JWT_ACCESS_SECRET='.length).trim().replace(/^["']|["']$/g, '');
  }
  if (!state.secret) throw new Error('JWT_ACCESS_SECRET not found (backend container down and not in ./.env)');
  return state.secret;
}

/** HS256, the JwtModule default: exactly what enrollment must mint (docs/ENROLLMENT_HANDOFF.md §3.2). */
function signStationToken({ id, serialNumber, branchId }, ttlSeconds = 30 * 86_400) {
  // A token without a valid sub / branchId is ~190 chars instead of ~320 and is rejected with 401.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(id ?? '') || !uuid.test(branchId ?? '') || !serialNumber) {
    throw new Error(`cannot mint: bad MACHINE row (id=${id}, branchId=${branchId}, serialNumber=${serialNumber})`);
  }
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: id, type: 'station', serialNumber, branchId, iat: now, exp: now + ttlSeconds };
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${body}.${createHmac('sha256', accessSecret()).update(body).digest('base64url')}`;
}

/** The MACHINE row of a serial: { id, serialNumber, branchId, enrollmentStatus }, or null. */
function machineBySerial(serial) {
  const row = psql(`SELECT id, serial_number, branch_id, enrollment_status FROM machines WHERE serial_number = '${serial}'`, { quiet: true })?.[0];
  return row ? { id: row[0], serialNumber: row[1], branchId: row[2], enrollmentStatus: row[3] } : null;
}

function setEnrollment(machineId, status) {
  psql(`UPDATE machines SET enrollment_status = '${status}', updated_at = now() WHERE id = '${machineId}'`, { quiet: true });
}

/** `station-enroll`: creates the row (or updates its status) the way enrollment would leave it. */
async function enrollStation() {
  const serial = await ask('serial number (must equal Agent__SerialNumber)', state.station?.serialNumber ?? 'STATION-DEV-01');
  const status = (await ask(`enrollmentStatus ${ENROLLMENT_STATUSES.join('|')}`, 'ENROLLED')).toUpperCase();
  // A manager enrolls into its own branch only; hq into any.
  const branches = (psql('SELECT id, name FROM branches ORDER BY created_at', { quiet: true }) ?? []).filter(([id]) => can('hq') || id === state.me?.branchId);
  if (branches.length === 0) {
    if (!can('hq')) return log(c.red('your branch was not found'));
    if (!(await confirm('no branch exists. Create "Dev branch"?'))) return;
    psql(`INSERT INTO branches (id, name, location, updated_at) VALUES (gen_random_uuid(), 'Dev branch', 'Lab', now())`);
    return enrollStation();
  }
  branches.forEach(([id, name], i) => log(`  ${i + 1}. ${name} ${c.dim(id)}`));
  const branch = branches[Number(await ask('branch #', 1)) - 1]?.[0] ?? branches[0][0];
  const row = psql(`
    INSERT INTO machines (id, serial_number, branch_id, agent_public_key, enrollment_status, updated_at)
    VALUES (gen_random_uuid(), '${serial}', '${branch}', '', '${status}', now())
    ON CONFLICT (serial_number) DO UPDATE SET enrollment_status = EXCLUDED.enrollment_status, updated_at = now()
    RETURNING id, branch_id, enrollment_status`)?.[0];
  if (!row) return;
  log(c.green(`${serial}  machine ${row[0]}  branch ${row[1]}  enrollmentStatus ${row[2]}`));
  if (await confirm('mint its station token now?')) await mintToken(serial);
  if (!state.station) await pickStation();
}

/** `station-token`: prints a station JWT and the PowerShell lines for the agent. */
async function mintToken(serialArg) {
  const serial = serialArg ?? (await ask('serial number', state.station?.serialNumber ?? 'STATION-DEV-01'));
  const machine = machineBySerial(serial);
  if (!machine) return log(c.red(`no MACHINE row for ${serial}: enroll it first (1)`));
  const days = Number(await ask('valid for days', 30));
  const token = signStationToken(machine, days * 86_400);
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  // Copying a long line out of a wrapped terminal is error-prone: the file holds the exact token.
  const file = join(tmpdir(), `station-token-${serial}.txt`);
  writeFileSync(file, token);
  // Ask the backend itself: 200 = accepted, 403 = valid but not ENROLLED, 401 = rejected.
  const check = await catalogStatus({ Authorization: `Bearer ${token}` }).catch(() => 0);
  const verdict = { 200: c.green('200 accepted'), 403: c.yellow('403 valid, but the row is not ENROLLED'), 401: c.red('401 REJECTED (secret or claims wrong)') }[check] ?? c.red(`${check} (backend unreachable?)`);
  log(`
${c.bold('Station token')} for ${serial} (${machine.enrollmentStatus}), valid ${days} days, ${token.length} chars ${c.dim('(normal: about 320)')}:
${token}

claims: ${JSON.stringify(claims)}
saved to: ${file}
backend check (GET /stations/me/games): ${verdict}

${c.bold('On the gaming PC (PowerShell, agent folder):')}
$env:Agent__ServerUrl    = "wss://localhost/agent-ws"   ${c.dim('# other PC: wss://cstam-server.local/agent-ws')}
$env:Agent__SerialNumber = "${serial}"
$env:Agent__StationToken = "${token}"
dotnet run
${c.dim(`or, any environment (elevated):  "<token>" | BaronDeskAgent.ServiceCore.exe --set-station-token`)}`);
}

async function setStationEnrollment() {
  const machine = machineBySerial(await ask('serial number', state.station?.serialNumber ?? 'STATION-DEV-01'));
  if (!machine) return log(c.red('no MACHINE row for that serial'));
  const status = (await ask(`enrollmentStatus ${ENROLLMENT_STATUSES.join('|')} (was ${machine.enrollmentStatus})`, 'ENROLLED')).toUpperCase();
  setEnrollment(machine.id, status);
  log(c.green(`${machine.serialNumber} -> ${status}. Takes effect on the next connect or REST call (an open socket stays open).`));
}

/** 101 if /agent-ws accepts the upgrade, else its HTTP status. */
function upgradeStatus(token) {
  const socket = new WebSocket(WS_URL, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => {
      resolve(101);
      socket.close();
    });
    socket.on('error', () => resolve(0));
  });
}

/** Admitted without a handshake? 'open' if still up after 750 ms, else the close code or the upgrade's HTTP status. */
function admission(token) {
  const socket = new WebSocket(WS_URL, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return new Promise((resolve) => {
    let timer;
    socket.on('open', () => {
      timer = setTimeout(() => {
        resolve('open');
        socket.close();
      }, 750);
    });
    socket.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('error', () => undefined);
  });
}

/** Handshakes as `serial`: 'ack', or the close code. Only used with tokens that must fail, so the real agent stays connected. */
function handshakeResult(token, serial) {
  const socket = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
  return new Promise((resolve) => {
    socket.on('open', () =>
      socket.send(JSON.stringify({ type: 'handshake', id: randomUUID(), ts: new Date().toISOString(), seq: 1, payload: { serialNumber: serial } })),
    );
    socket.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'handshake_ack') {
        resolve('ack');
        socket.close();
      }
    });
    socket.on('close', (code) => resolve(code));
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('error', () => undefined);
  });
}

async function catalogStatus(headers, query = '') {
  return (await fetch(`${BASE_URL}/stations/me/games${query}`, { headers })).status;
}

function machineCount(id, serial) {
  return Number(psql(`SELECT count(*) FROM machines WHERE id::text = '${id}' OR serial_number = '${serial}'`, { quiet: true })?.[0]?.[0] ?? -1);
}

/** `station-auth`: the admission cases, PASS/FAIL per line. Restores the enrollment status afterwards. */
async function admissionCases() {
  const machine = machineBySerial(await ask('serial number', state.station?.serialNumber ?? 'STATION-DEV-01'));
  if (!machine) return log(c.red('no MACHINE row for that serial: enroll it first (1)'));
  const valid = signStationToken(machine, 300);
  const expired = signStationToken(machine, -60);
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });
  let failed = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    log(`${ok ? c.green('PASS') : c.red('FAIL')}  ${label.padEnd(62)} got ${actual}, want ${expected}`);
  };
  const original = machine.enrollmentStatus;
  log(c.bold(`\nadmission cases for ${machine.serialNumber} (machine ${machine.id}, was ${original})`));
  log(c.dim('The real agent may reconnect during b.: it is refused while the row is not ENROLLED, then comes back.\n'));
  try {
    // a. ENROLLED + valid token: admitted, catalog served.
    setEnrollment(machine.id, 'ENROLLED');
    check('a. ENROLLED + valid token: /agent-ws stays open', await admission(valid), 'open');
    check('a. ENROLLED + valid token: GET /stations/me/games', await catalogStatus(bearer(valid)), 200);

    // b. Same station, not ENROLLED: 1008 on the socket, 403 on REST.
    for (const status of ['PENDING', 'INACTIVE', 'DEACTIVATED']) {
      setEnrollment(machine.id, status);
      check(`b. ${status}: /agent-ws close code`, await admission(valid), 1008);
      check(`b. ${status}: GET /stations/me/games`, await catalogStatus(bearer(valid)), 403);
    }
    setEnrollment(machine.id, 'ENROLLED');
    check('b. back to ENROLLED: /agent-ws stays open', await admission(valid), 'open');

    // c. Valid signature, machineId with no MACHINE row: rejected, nothing created.
    const ghostId = randomUUID();
    const ghostSerial = `GHOST-${ghostId.slice(0, 8)}`;
    const ghost = signStationToken({ id: ghostId, serialNumber: ghostSerial, branchId: machine.branchId }, 300);
    check('c. no MACHINE row: /agent-ws close code', await admission(ghost), 1008);
    check('c. no MACHINE row: handshake close code', await handshakeResult(ghost, ghostSerial), 1008);
    check('c. no MACHINE row: GET /stations/me/games', await catalogStatus(bearer(ghost)), 403);
    check('c. no MACHINE row created', machineCount(ghostId, ghostSerial), 0);

    // d. Token claims no longer match the row (branch moved / serial changed).
    const moved = signStationToken({ ...machine, branchId: randomUUID() }, 300);
    check('d. token branch != row branch: /agent-ws close code', await admission(moved), 1008);
    check('d. token branch != row branch: GET /stations/me/games', await catalogStatus(bearer(moved)), 401);
    check('d. token serial != handshake serial: close code', await handshakeResult(valid, `${machine.serialNumber}-X`), 1008);

    // e. No token / bad tokens / serial-only: 401, nothing auto-created.
    const unknownSerial = `UNKNOWN-${randomUUID().slice(0, 8)}`;
    check('e. no token: WSS upgrade', await upgradeStatus(null), 401);
    check('e. no token: GET /stations/me/games', await catalogStatus({}), 401);
    check('e. ?serialNumber= only: GET /stations/me/games', await catalogStatus({}, `?serialNumber=${unknownSerial}`), 401);
    check('e. x-station-serial only: GET /stations/me/games', await catalogStatus({ 'x-station-serial': machine.serialNumber }), 401);
    check('e. no MACHINE row created for the unknown serial', machineCount('', unknownSerial), 0);
    check('e. garbage token: WSS upgrade', await upgradeStatus('garbage'), 401);
    check('e. expired token: WSS upgrade', await upgradeStatus(expired), 401);
    check('e. expired token: GET /stations/me/games', await catalogStatus(bearer(expired)), 401);
    check('e. user access token: WSS upgrade', await upgradeStatus(state.accessToken), 401);
    check('e. user access token: GET /stations/me/games', await catalogStatus(bearer(state.accessToken)), 401);
  } finally {
    setEnrollment(machine.id, original);
  }
  log(`\n${failed ? c.red(`${failed} failed`) : c.green('all passed')}  ${c.dim(`(enrollmentStatus restored to ${original})`)}`);
}

/** What GET /stations/me/games serves the agent, with a freshly minted station token. */
async function agentCatalog() {
  const machine = machineBySerial(await ask('serial number', state.station?.serialNumber ?? 'STATION-DEV-01'));
  if (!machine) return log(c.red('no MACHINE row for that serial'));
  const res = await fetch(`${BASE_URL}/stations/me/games`, { headers: { Authorization: `Bearer ${signStationToken(machine, 60)}` } });
  log(`GET /stations/me/games (${machine.serialNumber}) -> ${res.status}`);
  console.dir(await res.json().catch(() => null), { depth: 5 });
}

function listMachines() {
  const rows = psql('SELECT serial_number, enrollment_status, status, branch_id, last_seen, id FROM machines ORDER BY created_at', { quiet: true });
  if (rows) console.table(rows.map(([serial, enrollment, status, branch, lastSeen, id]) => ({ serial, enrollment, status, branch, lastSeen, id })));
}

// Enrollment is an admin+ action (docs/ENROLLMENT_HANDOFF.md §4.3).
function enrollmentMenu() {
  return menu('Enrollment (stand-in, see docs/ENROLLMENT_HANDOFF.md)', [
    { key: '1', label: 'enroll a station (create / update MACHINE row)', min: 'admin', run: enrollStation },
    { key: '2', label: 'mint a station token for the agent', min: 'admin', run: () => mintToken() },
    { key: '3', label: 'set enrollmentStatus (revoke / restore)', min: 'admin', run: setStationEnrollment },
    { key: '4', label: 'run admission cases (PASS/FAIL)', min: 'admin', run: admissionCases },
    { key: '5', label: "agent's view: GET /stations/me/games", min: 'admin', run: agentCatalog },
    { key: '6', label: 'list MACHINE rows', min: 'admin', run: listMachines },
  ]);
}

// ---------------------------------------------------------------- users

async function gamerLogin(username, password) {
  const res = await http('POST', '/auth/login', { username, password });
  if (!res.ok) return;
  state.gamer = { username, password, accessToken: res.data.accessToken, gamerProfileId: null };
  const wallet = await http('GET', '/wallets/me', undefined, { as: 'gamer', quiet: true });
  if (wallet.ok) state.gamer.gamerProfileId = wallet.data.gamerProfileId;
  log(c.green(`gamer: ${username} (gamerProfileId ${state.gamer.gamerProfileId ?? '?'})`));
}

async function createGamer() {
  const username = await ask('username', `gamer-${Date.now().toString(36)}`);
  const password = await ask('password', 'gamer-pass-123');
  const res = await http('POST', '/users', { username, password });
  if (res.ok) {
    log(c.green(`created user ${res.data.id}`));
    await gamerLogin(username, password);
  }
}

// A MANAGER may only create / promote EMPLOYEEs (and demote to GAMER), in its
// own branch; only an ADMIN (hq) hands out MANAGER or ADMIN, in any branch.
const assignableRoles = (forCreate) =>
  can('hq') ? (forCreate ? ['EMPLOYEE', 'MANAGER'] : ['GAMER', 'EMPLOYEE', 'MANAGER', 'ADMIN']) : forCreate ? ['EMPLOYEE'] : ['GAMER', 'EMPLOYEE'];

async function pickRole(forCreate) {
  const roles = assignableRoles(forCreate);
  if (roles.length === 1) return roles[0];
  const role = (await ask(`role ${roles.join('|')}`, roles[0])).toUpperCase();
  return roles.includes(role) ? role : roles[0];
}

/** hq picks any branch; a manager's is fixed to its own. */
async function pickBranch() {
  return can('hq') ? ask('branchId', await branchId()) : state.me.branchId;
}

async function createEmployee() {
  const body = {
    username: await ask('username', `staff-${Date.now().toString(36)}`),
    password: await ask('password', 'staff-pass-123'),
    role: await pickRole(true),
    branchId: await pickBranch(),
  };
  const res = await http('POST', '/employees', body);
  if (res.ok) log(c.green(`created ${body.role} ${body.username} / ${body.password} (${res.data.id}). Test with CONSOLE_USER / CONSOLE_PASS`));
}

async function changeRole() {
  const id = await ask('user id');
  const role = await pickRole(false);
  const body = { role };
  if (role === 'EMPLOYEE' || role === 'MANAGER') body.branchId = await pickBranch();
  await http('PATCH', `/users/${id}/role`, body);
}

function usersMenu() {
  return menu(() => `Users ${c.dim(`(acting gamer: ${state.gamer?.username ?? 'none'})`)}`, [
    { key: '1', label: 'my profile (GET /auth/me)', min: 'self', run: async () => console.dir((await http('GET', '/auth/me')).data) },
    { section: 'front desk (staff)', when: () => !isGamerConsole() },
    { key: '2', label: 'register a gamer (POST /users) and act as it', min: 'staff', run: createGamer },
    { key: '3', label: 'act as an existing gamer (log in with its password)', min: 'staff', run: async () => gamerLogin(await ask('username'), await ask('password')) },
    { key: '4', label: 'get a user by id (own branch)', min: 'staff', run: async () => console.dir((await http('GET', `/users/${await ask('user id')}`)).data) },
    { section: 'staff accounts (manager / admin)' },
    { key: '5', label: () => `create ${assignableRoles(true).join(' / ')}`, min: 'admin', run: createEmployee },
    { key: '6', label: () => `change a user's role (${assignableRoles(false).join(' / ')})`, min: 'admin', run: changeRole },
  ]);
}

// ---------------------------------------------------------------- wallet

function requireGamer() {
  if (!state.gamer?.gamerProfileId) log(c.yellow('no gamer yet: users menu (u), 2 or 3'));
  return state.gamer?.gamerProfileId;
}

async function walletMove(kind) {
  const gamerProfileId = await ask('gamerProfileId', state.gamer?.gamerProfileId ?? '');
  const body = { amount: Number(await ask('amount (cents)', 10000)) };
  const type = await ask(`type (empty = ${kind.toUpperCase()}) PAYMENT|REFUND|ADJUSTMENT|CREDIT|DEBIT`, '');
  if (type) body.type = type.toUpperCase();
  const key = await ask('idempotencyKey (empty = none; reuse one to test dedupe)', '');
  if (key) body.idempotencyKey = key;
  const res = await http('POST', `/wallets/${gamerProfileId}/${kind}`, body);
  if (res.ok) console.dir(res.data);
}

async function showEntries(as) {
  const path = as === 'gamer' ? '/wallets/me/entries?take=20' : `/wallets/${await ask('gamerProfileId', state.gamer?.gamerProfileId ?? '')}/entries?take=20`;
  const res = await http('GET', path, undefined, { as });
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (res.ok) console.table(rows.map((e) => ({ type: e.type, amount: e.amount, balanceAfter: e.balanceAfter, sessionId: e.sessionId ?? '', createdAt: e.createdAt })));
}

/** "my ..." in a gamer console, "<name>'s ..." when staff acts as a gamer. */
const gamerLabel = (what) => (isGamerConsole() ? `my ${what}` : `${state.gamer?.username}'s ${what} (acting as the gamer)`);

function walletMenu() {
  return menu(() => `Wallet ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'}, gamerProfileId ${state.gamer?.gamerProfileId ?? '-'})`)}`, [
    { key: '1', label: () => gamerLabel('wallet'), min: 'self', when: () => !!state.gamer, run: async () => console.dir((await http('GET', '/wallets/me', undefined, { as: 'gamer' })).data) },
    { key: '2', label: () => gamerLabel('ledger'), min: 'self', when: () => !!state.gamer, run: () => showEntries('gamer') },
    { section: 'front desk (staff)' },
    { key: '3', label: 'wallet by gamerProfileId', min: 'staff', run: async () => console.dir((await http('GET', `/wallets/${await ask('gamerProfileId', state.gamer?.gamerProfileId ?? '')}`)).data) },
    { key: '4', label: 'ledger by gamerProfileId', min: 'staff', run: () => showEntries('staff') },
    { key: '5', label: 'credit (top up)', min: 'staff', run: () => walletMove('credit') },
    { key: '6', label: 'debit', min: 'staff', run: () => walletMove('debit') },
  ]);
}

// ---------------------------------------------------------------- membership / subscription plans

async function listPlans(kind) {
  const res = await http('GET', `/${kind}-plans`);
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (res.ok) console.dir(rows, { depth: 5 });
  return rows;
}

async function createPlan(kind) {
  const body = {
    name: await ask('name', `${kind === 'membership' ? 'Gold' : 'Night owl'} ${Date.now().toString(36)}`),
    price: Number(await ask('price (currency units, x100 = cents debited)', 5)),
    durationDays: Number(await ask('durationDays', 30)),
  };
  if (kind === 'membership') {
    body.discountPercent = Number(await ask('discountPercent', 50));
    body.bookingAdvanceDays = Number(await ask('bookingAdvanceDays', 7));
  } else {
    const raw = await ask(
      'benefits JSON',
      '{"windows":[{"daysOfWeek":[0,1,2,3,4,5,6],"startTime":"00:00","endTime":"23:59","discountPercent":20}]}',
    );
    body.benefits = JSON.parse(raw);
  }
  const res = await http('POST', `/${kind}-plans`, body);
  if (res.ok) log(c.green(`created ${kind} plan ${res.data.id}`));
}

async function updatePlan(kind) {
  await listPlans(kind);
  const id = await ask('plan id');
  const raw = await ask('JSON patch', kind === 'membership' ? '{"discountPercent":25}' : '{"price":10}');
  await http('PATCH', `/${kind}-plans/${id}`, JSON.parse(raw));
}

async function deletePlan(kind) {
  await listPlans(kind);
  await http('DELETE', `/${kind}-plans/${await ask('plan id')}`);
}

async function purchasePlan(kind) {
  if (!requireGamer()) return;
  await listPlans(kind);
  const id = await ask('plan id');
  const key = await ask('idempotencyKey (empty = none; reuse to test dedupe)', '');
  const res = await http('POST', `/${kind}-plans/${id}/purchase`, key ? { idempotencyKey: key } : {}, { as: 'gamer' });
  if (res.ok) console.dir(res.data, { depth: 4 });
}

function plansMenu() {
  const gamer = () => !!state.gamer;
  return menu(() => `Plans ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'})`)}`, [
    { section: 'membership' },
    { key: '1', label: 'list membership plans', min: 'self', run: () => listPlans('membership') },
    { key: '2', label: () => `buy a membership (${gamerLabel('wallet')})`, min: 'self', when: gamer, run: () => purchasePlan('membership') },
    { key: '3', label: () => gamerLabel('membership'), min: 'self', when: gamer, run: async () => console.dir((await http('GET', '/memberships/me', undefined, { as: 'gamer' })).data, { depth: 4 }) },
    { key: '4', label: 'create membership plan', min: 'admin', run: () => createPlan('membership') },
    { key: '5', label: 'update membership plan', min: 'admin', run: () => updatePlan('membership') },
    { key: '6', label: 'delete membership plan', min: 'admin', run: () => deletePlan('membership') },
    { section: 'subscription' },
    { key: '7', label: 'list subscription plans', min: 'self', run: () => listPlans('subscription') },
    { key: '8', label: () => `buy a subscription (${gamerLabel('wallet')})`, min: 'self', when: gamer, run: () => purchasePlan('subscription') },
    { key: '9', label: () => gamerLabel('subscriptions'), min: 'self', when: gamer, run: async () => console.dir((await http('GET', '/subscriptions/me', undefined, { as: 'gamer' })).data, { depth: 4 }) },
    { key: 'c', label: 'create subscription plan', min: 'admin', run: () => createPlan('subscription') },
    { key: 'u', label: 'update subscription plan', min: 'admin', run: () => updatePlan('subscription') },
    { key: 'd', label: 'delete subscription plan', min: 'admin', run: () => deletePlan('subscription') },
  ]);
}

// ---------------------------------------------------------------- pricing, reservations, sessions, billing

async function showPricing() {
  const res = await http('GET', `/branches/${await branchId()}/pricing`);
  if (res.ok) {
    console.dir(res.data);
    const payg = res.data.paygRate;
    if (payg) log(c.dim(`paygRate ${payg} cents/hour = ${Math.round(payg / 60)} cents/minute before membership discount`));
  }
}

async function setPricing() {
  // 6000 cents/hour = 100 cents/minute: one minute of play shows up clearly in the wallet.
  const body = {
    paygRate: Number(await ask('paygRate (cents/hour)', 6000)),
    bookingRate: Number(await ask('bookingRate (cents/hour)', 6000)),
  };
  await http('PUT', `/branches/${await branchId()}/pricing`, body);
}

async function createReservation() {
  const gamerProfileId = await ask('gamerProfileId', state.gamer?.gamerProfileId ?? '');
  const status = (await ask('status PENDING|CONFIRMED|CANCELLED', 'CONFIRMED')).toUpperCase();
  const minutes = Number(await ask('length (minutes)', 120));
  const rows = psql(`
    INSERT INTO reservations (id, gamer_profile_id, machine_id, start_time, end_time, status, updated_at)
    VALUES (gen_random_uuid(), '${gamerProfileId}', '${state.station.id}', now(), now() + interval '${minutes} minutes', '${status}', now())
    RETURNING id`);
  if (rows?.[0]) {
    state.reservationId = rows[0][0];
    log(c.green(`reservation ${state.reservationId} (${status}) on ${state.station.serialNumber}`));
  }
}

async function listReservations() {
  const rows = psql(`
    SELECT r.id, r.status, u.username, r.start_time, r.end_time,
           (SELECT count(*) FROM sessions s WHERE s.reservation_id = r.id)
      FROM reservations r
      JOIN gamer_profiles gp ON gp.id = r.gamer_profile_id
      JOIN users u ON u.id = gp.user_id
     WHERE r.machine_id = '${state.station.id}'
     ORDER BY r.created_at DESC LIMIT 10`);
  if (rows) console.table(rows.map(([id, status, gamer, start, end, sessions]) => ({ id, status, gamer, start, end, sessions })));
}

async function setReservationStatus() {
  const id = await ask('reservation id', state.reservationId ?? '');
  const status = (await ask('status PENDING|CONFIRMED|ACTIVE|COMPLETED|CANCELLED|NO_SHOW', 'CONFIRMED')).toUpperCase();
  psql(`UPDATE reservations SET status = '${status}', updated_at = now() WHERE id = '${id}'`);
}

async function startSession() {
  const reservationId = await ask('reservationId', state.reservationId ?? '');
  const res = await http('POST', '/sessions', { reservationId });
  if (!res.ok) return;
  state.session = res.data;
  log(c.bold(c.green(`session ${res.data.id} ${res.data.status}, rate ${res.data.rateCentsPerMinute} cents/min`)));
  log(c.bold(c.yellow(`PIN for the gamer: ${res.data.pin}`)));
  log(c.dim('The booking UNLOCK is on its way: watch [command_update] UNLOCK and the PIN prompt on the PC.'));
}

async function showSession({ watch = false } = {}) {
  const id = state.session?.id ?? (await ask('session id'));
  const seconds = watch ? Number(await ask('watch for seconds (refresh every 5 s)', 60)) : 0;
  const until = Date.now() + seconds * 1000;
  let last;
  do {
    const res = await http('GET', `/sessions/${id}`, undefined, { quiet: watch });
    if (!res.ok) return;
    const s = res.data;
    const line = `${s.status} metered=${s.meteredSeconds}s rate=${s.rateCentsPerMinute}c/min lockedAt=${s.lockedAt ?? '-'} settledAt=${s.settledAt ?? '-'}`;
    if (line !== last) log(c.cyan(`[session] ${line}`));
    last = line;
    if (s.billingBreakdown) log(c.bold(`billingBreakdown: ${JSON.stringify(s.billingBreakdown)}`));
    if (s.status === 'COMPLETED' || s.status === 'CANCELLED') return;
    if (watch) await new Promise((r) => setTimeout(r, 5000));
  } while (Date.now() < until);
}

async function endSessionRest() {
  const id = await ask('session id', state.session?.id ?? '');
  const reason = await ask('reason (empty = none)', 'staff_end');
  const res = await http('POST', `/sessions/${id}/end`, reason ? { reason } : {});
  if (res.ok) log(c.dim(`END_SESSION command ${res.data.commandId} queued. Settlement runs once the agent reports the session gone.`));
}

async function listSessions() {
  const rows = psql(`
    SELECT s.id, s.status, s.metered_seconds, s.rate_cents_per_minute, s.locked_at, s.settled_at, s.billing_breakdown
      FROM sessions s JOIN reservations r ON r.id = s.reservation_id
     WHERE r.machine_id = '${state.station.id}'
     ORDER BY s.created_at DESC LIMIT 10`);
  if (rows)
    console.table(rows.map(([id, status, metered, rate, lockedAt, settledAt, breakdown]) => ({ id, status, metered, rate, lockedAt, settledAt, breakdown })));
}

// Sessions have no gamer-facing route: the whole menu is staff+.
function billingMenu() {
  const station = () => !!state.station;
  return menu(
    () => `Sessions and billing ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'}, reservation: ${state.reservationId ?? '-'}, session: ${state.session?.id ?? '-'})`)}`,
    [
      { section: 'pricing' },
      { key: '1', label: 'show branch pricing', min: 'staff', run: showPricing },
      { key: '2', label: 'set branch pricing', min: 'admin', run: setPricing },
      { section: 'reservation (SQL: no REST route yet)' },
      { key: '3', label: 'create reservation on this station', min: 'staff', when: station, run: createReservation },
      { key: '4', label: 'list station reservations', min: 'staff', when: station, run: listReservations },
      { key: '5', label: 'set reservation status', min: 'staff', when: station, run: setReservationStatus },
      { section: 'session' },
      { key: '6', label: 'start session (POST /sessions) -> PIN', min: 'staff', run: startSession },
      { key: '7', label: 'show session', min: 'staff', run: () => showSession() },
      { key: '8', label: 'watch session (poll every 5 s)', min: 'staff', run: () => showSession({ watch: true }) },
      { key: '9', label: 'end session (POST /sessions/:id/end)', min: 'staff', run: endSessionRest },
      { key: 'l', label: 'list station sessions', min: 'staff', when: station, run: listSessions },
    ],
  );
}

// ---------------------------------------------------------------- misc

async function rawRequest() {
  const method = (await ask('method', 'POST')).toUpperCase();
  const path = await ask('path', state.station ? `/api/v1/stations/${state.station.id}/commands` : '/auth/me');
  const raw = await ask('JSON body (empty = none)', '');
  const res = await http(method, path, raw ? JSON.parse(raw) : undefined);
  console.dir(res.data, { depth: 6 });
}

async function feedMenu() {
  for (const key of Object.keys(state.feed)) {
    state.feed[key] = (await ask(`show ${key} events? true|false`, state.feed[key])) === 'true';
  }
}

async function main() {
  log(c.bold(`Station console -> ${BASE_URL}`));
  await login();

  // Stations, commands and the live feed are staff+. A gamer console skips them.
  if (can('staff')) {
    connectFeed();
    await pickStation();
    while (!state.station && can('admin')) {
      if (!(await confirm('no station selected. Open the enrollment menu?'))) break;
      await enrollmentMenu();
      if (!state.station) await pickStation();
    }
    if (!state.station) {
      log(c.yellow(can('admin') ? 'no station: station items hidden (e to enroll, p to pick)' : 'no station in your branch: ask a manager to enroll one'));
    }
  }

  const station = () => !!state.station;
  await menu(
    () =>
      `${state.me?.username} (${state.me?.role})` +
      (state.station ? ` | station ${state.station.serialNumber}` : '') +
      (isGamerConsole() ? '' : c.dim(` | acting gamer: ${state.gamer?.username ?? 'none'} | session: ${state.session?.id ?? '-'}`)),
    [
      { section: 'station commands', when: station },
      { key: 's', label: 'station status', min: 'staff', when: station, run: showStation },
      { key: '1', label: 'LOCK', min: 'staff', when: station, run: () => issue({ type: 'LOCK' }) },
      { key: '2', label: 'UNLOCK (admin unlock)', min: 'staff', when: station, run: () => issue({ type: 'UNLOCK' }) },
      { key: '3', label: 'UNLOCK (booking + PIN)', min: 'staff', when: station, run: unlockBooking },
      { key: '4', label: 'LAUNCH_GAME', min: 'staff', when: station, run: launchGame },
      { key: '5', label: 'END_SESSION (command)', min: 'staff', when: station, run: endSession },
      { key: '6', label: 'CATALOG_UPDATE', min: 'staff', when: station, run: () => issue({ type: 'CATALOG_UPDATE' }) },
      { key: '7', label: 'SHUTDOWN', min: 'admin', when: station, run: shutdown },
      { key: '8', label: 'fault injection (dev)', min: 'staff', when: station, run: simulate },
      { key: 'c', label: 'recent commands', min: 'staff', when: station, run: listCommands },
      { key: 't', label: 'telemetry', min: 'staff', when: station, run: telemetry },
      { section: 'station tools' },
      { key: 'a', label: 'alerts (list / resolve)', min: 'staff', run: alerts },
      { key: 'p', label: 'pick another station', min: 'staff', run: pickStation },
      { key: 'f', label: 'live feed filters', min: 'staff', run: feedMenu },
      { section: 'business' },
      { key: 'u', label: () => (can('admin') ? 'users (profile, gamers, staff accounts)' : can('staff') ? 'users (profile, gamers)' : 'my profile'), min: 'self', run: usersMenu },
      { key: 'w', label: () => (can('staff') ? 'wallet (top up, debit, ledger)' : 'my wallet'), min: 'self', run: walletMenu },
      { key: 'm', label: () => (can('admin') ? 'membership / subscription plans' : 'membership / subscription plans (browse, buy)'), min: 'self', run: plansMenu },
      { key: 'b', label: 'pricing, reservation, session, billing', min: 'staff', run: billingMenu },
      { key: 'g', label: () => (can('admin') ? 'games / catalog' : 'games (browse)'), min: 'self', run: gamesMenu },
      { section: 'tools' },
      { key: 'e', label: 'enrollment (station row, token, admission cases)', min: 'admin', run: enrollmentMenu },
      { key: 'r', label: 'raw request (test a 403 on purpose)', min: 'self', run: rawRequest },
    ],
    { root: true },
  );
}

main()
  .catch((err) => log(c.red(err.stack ?? err.message)))
  .finally(() => {
    socket?.close();
    rl.close();
  });

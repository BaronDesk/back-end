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
import { existsSync, readFileSync } from 'node:fs';
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
  log(c.green(`logged in as ${USERNAME}`), c.dim(JSON.stringify(me.data)));
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

async function gamesMenu() {
  for (;;) {
    log(`
${c.bold('Games')}
  1. list global catalog            6. assign to branch
  2. station catalog + catalog_status  7. unassign from branch
  3. create game                    8. enable / disable game
  4. assign to this station         9. edit game field
  5. unassign from this station     0. back`);
    const choice = await ask('>');
    const actions = {
      1: listGames,
      2: stationCatalog,
      3: createGame,
      4: assignStation,
      5: unassignStation,
      6: () => branchAssignment('PUT'),
      7: () => branchAssignment('DELETE'),
      8: toggleGame,
      9: editGame,
    };
    if (choice === '0' || choice === '') return;
    await actions[choice]?.();
  }
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
      [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'cstam', '-d', 'cstam', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (!quiet) log(c.dim(`psql: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`));
    return out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.split('|'));
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
  const branches = psql('SELECT id, name FROM branches ORDER BY created_at', { quiet: true }) ?? [];
  if (branches.length === 0) {
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
  log(`
${c.bold('Station token')} for ${serial} (${machine.enrollmentStatus}), valid ${days} days:
${token}

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

async function enrollmentMenu() {
  for (;;) {
    log(`
${c.bold('Enrollment (stand-in, see docs/ENROLLMENT_HANDOFF.md)')}
  1. enroll a station (create / update MACHINE row)   4. run admission cases (PASS/FAIL)
  2. mint a station token for the agent                5. agent's view: GET /stations/me/games
  3. set enrollmentStatus (revoke / restore)           6. list MACHINE rows
  0. back`);
    const choice = await ask('>');
    if (choice === '0' || choice === '') return;
    const actions = { 1: enrollStation, 2: () => mintToken(), 3: setStationEnrollment, 4: admissionCases, 5: agentCatalog, 6: listMachines };
    await actions[choice]?.();
  }
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

async function createEmployee() {
  const body = {
    username: await ask('username', `staff-${Date.now().toString(36)}`),
    password: await ask('password', 'staff-pass-123'),
    role: (await ask('role EMPLOYEE|MANAGER', 'EMPLOYEE')).toUpperCase(),
    branchId: await ask('branchId', await branchId()),
  };
  const res = await http('POST', '/employees', body);
  if (res.ok) log(c.green(`created ${body.role} ${body.username} / ${body.password} (${res.data.id}). Test with CONSOLE_USER / CONSOLE_PASS`));
}

async function changeRole() {
  const id = await ask('user id');
  const role = (await ask('role GAMER|EMPLOYEE|MANAGER|ADMIN', 'EMPLOYEE')).toUpperCase();
  const body = { role };
  if (role === 'EMPLOYEE' || role === 'MANAGER') body.branchId = await ask('branchId', await branchId());
  await http('PATCH', `/users/${id}/role`, body);
}

async function usersMenu() {
  for (;;) {
    log(`
${c.bold('Users')} ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'})`)}
  1. create gamer (POST /users) and log in as it   4. change a user's role
  2. log in as an existing gamer                     5. get user by id
  3. create employee / manager                       6. gamer /auth/me
  0. back`);
    const choice = await ask('>');
    if (choice === '0' || choice === '') return;
    const actions = {
      1: createGamer,
      2: async () => gamerLogin(await ask('username'), await ask('password')),
      3: createEmployee,
      4: changeRole,
      5: async () => console.dir((await http('GET', `/users/${await ask('user id')}`)).data),
      6: async () => console.dir((await http('GET', '/auth/me', undefined, { as: 'gamer' })).data),
    };
    await actions[choice]?.();
  }
}

// ---------------------------------------------------------------- wallet

function requireGamer() {
  if (!state.gamer?.gamerProfileId) log(c.yellow('no gamer yet: users menu (u), 1 or 2'));
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

async function walletMenu() {
  for (;;) {
    log(`
${c.bold('Wallet')} ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'}, gamerProfileId ${state.gamer?.gamerProfileId ?? '-'})`)}
  1. gamer: GET /wallets/me           4. staff: wallet by gamerProfileId
  2. gamer: GET /wallets/me/entries   5. staff: entries by gamerProfileId
  3. staff: credit                    6. staff: debit
  0. back`);
    const choice = await ask('>');
    if (choice === '0' || choice === '') return;
    const actions = {
      1: async () => console.dir((await http('GET', '/wallets/me', undefined, { as: 'gamer' })).data),
      2: () => showEntries('gamer'),
      3: () => walletMove('credit'),
      4: async () => console.dir((await http('GET', `/wallets/${await ask('gamerProfileId', state.gamer?.gamerProfileId ?? '')}`)).data),
      5: () => showEntries('staff'),
      6: () => walletMove('debit'),
    };
    await actions[choice]?.();
  }
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

async function plansMenu() {
  for (;;) {
    log(`
${c.bold('Plans')} ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'})`)}
  Membership                         Subscription
  1. list                            6. list
  2. create (admin)                  7. create (admin)
  3. update (admin)                  8. update (admin)
  4. delete (admin)                  9. delete (admin)
  5. gamer: purchase                 p. gamer: purchase
  m. gamer: GET /memberships/me      s. gamer: GET /subscriptions/me
  0. back`);
    const choice = (await ask('>')).toLowerCase();
    if (choice === '0' || choice === '') return;
    const actions = {
      1: () => listPlans('membership'),
      2: () => createPlan('membership'),
      3: () => updatePlan('membership'),
      4: () => deletePlan('membership'),
      5: () => purchasePlan('membership'),
      m: async () => console.dir((await http('GET', '/memberships/me', undefined, { as: 'gamer' })).data, { depth: 4 }),
      6: () => listPlans('subscription'),
      7: () => createPlan('subscription'),
      8: () => updatePlan('subscription'),
      9: () => deletePlan('subscription'),
      p: () => purchasePlan('subscription'),
      s: async () => console.dir((await http('GET', '/subscriptions/me', undefined, { as: 'gamer' })).data, { depth: 4 }),
    };
    await actions[choice]?.();
  }
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

async function billingMenu() {
  for (;;) {
    log(`
${c.bold('Sessions and billing')} ${c.dim(`(gamer: ${state.gamer?.username ?? 'none'}, reservation: ${state.reservationId ?? '-'}, session: ${state.session?.id ?? '-'})`)}
  1. show branch pricing          6. start session (POST /sessions) -> PIN
  2. set branch pricing (admin)   7. show session
  3. create reservation (SQL)     8. watch session (poll every 5 s)
  4. list station reservations    9. end session (POST /sessions/:id/end)
  5. set reservation status (SQL) l. list station sessions (SQL)
  0. back`);
    const choice = (await ask('>')).toLowerCase();
    if (choice === '0' || choice === '') return;
    const actions = {
      1: showPricing,
      2: setPricing,
      3: createReservation,
      4: listReservations,
      5: setReservationStatus,
      6: startSession,
      7: () => showSession(),
      8: () => showSession({ watch: true }),
      9: endSessionRest,
      l: listSessions,
    };
    await actions[choice]?.();
  }
}

// ---------------------------------------------------------------- misc

async function rawRequest() {
  const method = (await ask('method', 'POST')).toUpperCase();
  const path = await ask('path', `/api/v1/stations/${state.station.id}/commands`);
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
  connectFeed();
  await pickStation();
  while (!state.station) {
    if (!(await confirm('no station selected. Open the enrollment menu?'))) return;
    await enrollmentMenu();
    if (!state.station) await pickStation();
  }

  const actions = {
    s: showStation,
    1: () => issue({ type: 'LOCK' }),
    2: () => issue({ type: 'UNLOCK' }),
    3: unlockBooking,
    4: launchGame,
    5: endSession,
    6: () => issue({ type: 'CATALOG_UPDATE' }),
    7: shutdown,
    8: simulate,
    c: listCommands,
    g: gamesMenu,
    t: telemetry,
    a: alerts,
    r: rawRequest,
    f: feedMenu,
    p: pickStation,
    u: usersMenu,
    w: walletMenu,
    m: plansMenu,
    b: billingMenu,
    e: enrollmentMenu,
  };

  for (;;) {
    log(`
${c.bold(`[${state.station.serialNumber}]`)} ${c.dim(`gamer: ${state.gamer?.username ?? 'none'} | session: ${state.session?.id ?? '-'}`)}
  Station commands                                     Business flow
  s. station status          1. LOCK                   u. users (gamer, employee, roles)
  2. UNLOCK (admin)          3. UNLOCK (booking + PIN) w. wallet (credit, debit, ledger)
  4. LAUNCH_GAME             5. END_SESSION (command)  m. membership / subscription plans
  6. CATALOG_UPDATE          7. SHUTDOWN               b. pricing, reservation, session, billing
  8. fault injection         c. recent commands
  g. games / catalog         t. telemetry              a. alerts (list / resolve)
  r. raw request             f. feed filters           p. pick another station
  e. enrollment (station row, token, admission cases)  q. quit`);
    const choice = (await ask('>')).toLowerCase();
    if (choice === 'q') break;
    try {
      await actions[choice]?.();
    } catch (err) {
      log(c.red(`error: ${err.message}`));
    }
  }
}

main()
  .catch((err) => log(c.red(err.stack ?? err.message)))
  .finally(() => {
    socket?.close();
    rl.close();
  });

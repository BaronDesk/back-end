#!/usr/bin/env node
/**
 * Station console: a profile-aware command palette for the physical test of
 * the BaronDesk backend and desktop agent.
 *
 * Log in as any profile (GAMER / EMPLOYEE / MANAGER / ADMIN). The palette lists
 * every command that profile may run, grouped by feature, in any order. Each
 * command prompts for its inputs, makes one REST call (or observes Socket.IO)
 * and prints the request and the response. The backend owns all business
 * logic: the console never decides an outcome.
 *
 * Test plan: docs/STATION_PHYSICAL_TEST.md
 *
 * Usage (from the repo root, stack up):
 *   node scripts/station-console.mjs
 *
 * Environment (all optional):
 *   BASE_URL      default http://localhost:3000 (Nest directly, no TLS)
 *   CONSOLE_USER  first login, default hq-admin (set it empty to start logged out)
 *   CONSOLE_PASS  default change-me-immediately
 *
 * Top-level keys (type at the prompt):
 *   <number>  run that command          h / Enter  show the palette
 *   /text     palette filtered by text  l          login as... (new or saved identity)
 *   s         swap to the previous identity (one key)
 *   o         observer on/off (/dashboard-io)       t  telemetry frames on/off
 *   v         show / hide commands above your scope  c  show remembered ids
 *   r         raw request with the active token      q  quit
 */
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { io } from 'socket.io-client';
import { WebSocket } from 'ws';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/agent-ws`;
const FIRST_USER = process.env.CONSOLE_USER ?? 'hq-admin';
const FIRST_PASS = process.env.CONSOLE_PASS ?? 'change-me-immediately';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (q, def) => {
  const hint = def === '' ? '[none]' : `[${def}]`;
  const answer = (await rl.question(def !== undefined && def !== null ? `${q} ${c.dim(hint)}: ` : `${q}: `)).trim();
  return answer === '' && def !== undefined && def !== null ? String(def) : answer;
};
const askNum = async (q, def) => Number(await ask(q, def));
const askJson = async (q, def) => {
  const raw = await ask(q, def);
  return raw ? JSON.parse(raw) : undefined;
};
const confirm = async (q) => /^y(es)?$/i.test(await ask(`${q} (y/N)`, 'N'));
/** Drops keys whose value is '' or undefined, so optional fields left empty are not sent. */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined));
const stamp = () => new Date().toISOString().slice(11, 23);

function log(...args) {
  // Keep observer frames from landing in the middle of a prompt.
  stdout.write('\r\x1b[K');
  console.log(...args);
}

// ---------------------------------------------------------------- identities and scope
//
// Mirrors the backend's role -> scope mapping (src/common/utils/scope.ts).
// It only decides what the palette lists; the server still enforces every
// route, and a hidden command can be run anyway to see the 403.

const ROLE_SCOPE = { GAMER: 'self', EMPLOYEE: 'staff', MANAGER: 'admin', ADMIN: 'hq' };
const SCOPE_RANK = { public: 0, station: 0, self: 1, staff: 2, admin: 3, hq: 4 };

/** username -> { username, password, accessToken, refreshToken, me, scope } */
const identities = new Map();
let active = null;
let previous = null;

const scope = () => active?.scope ?? 'public';
const can = (min) => SCOPE_RANK[scope()] >= SCOPE_RANK[min];

/** Ids the last responses returned, offered as prompt defaults. */
const ctx = {};
const remember = (values) => {
  for (const [key, value] of Object.entries(values)) if (value) ctx[key] = value;
};

let showLocked = false;

// ---------------------------------------------------------------- HTTP

/** Long values in a printed request body (keys, signatures) are cut; the request itself is sent whole. */
function printable(body) {
  return JSON.stringify(body, (key, value) => {
    if (key === 'password') return '***';
    if (typeof value === 'string' && value.length > 100) return `${value.slice(0, 40)}...(${value.length} chars)`;
    return value;
  });
}

/**
 * One REST call, printed in full. `token: null` sends no Authorization header.
 * A 401 on the active identity refreshes (or logs in again) once and retries.
 */
async function http(method, path, { body, token = active?.accessToken, headers = {}, retried = false } = {}) {
  const who = token && token === active?.accessToken ? active.username : token ? 'other token' : 'no token';
  log(c.cyan(`-> ${method} ${path}`) + (body !== undefined ? ` ${printable(body)}` : '') + c.dim(`  (${who})`));
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    log(c.red(`<- network error: ${err.cause?.code ?? err.message} (is the backend up at ${BASE_URL}?)`));
    return { status: 0, ok: false, data: null };
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401 && !retried && active && token === active.accessToken && !path.startsWith('/auth/')) {
    log(c.dim('<- 401: access token expired? refreshing and retrying once'));
    if (await renew(active)) return http(method, path, { body, token: active.accessToken, headers, retried: true });
  }
  const tag = res.ok ? c.green(`<- ${res.status}`) : c.red(`<- ${res.status}`);
  log(tag);
  if (data !== null && data !== '') log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return { status: res.status, ok: res.ok, data };
}

async function login(username, password) {
  const res = await http('POST', '/auth/login', { body: { username, password }, token: null });
  if (!res.ok) return null;
  const me = await http('GET', '/auth/me', { token: res.data.accessToken });
  if (!me.ok) return null;
  const identity = {
    username,
    password,
    accessToken: res.data.accessToken,
    refreshToken: res.data.refreshToken,
    me: me.data,
    scope: ROLE_SCOPE[me.data.role] ?? 'self',
  };
  identities.set(username, identity);
  switchTo(identity);
  return identity;
}

/** Refresh, or log in again with the stored password. */
async function renew(identity) {
  const res = await http('POST', '/auth/refresh', { body: { refreshToken: identity.refreshToken }, token: null });
  if (res.ok) {
    identity.accessToken = res.data.accessToken;
    identity.refreshToken = res.data.refreshToken;
    return true;
  }
  const again = await http('POST', '/auth/login', { body: { username: identity.username, password: identity.password }, token: null });
  if (!again.ok) return false;
  identity.accessToken = again.data.accessToken;
  identity.refreshToken = again.data.refreshToken;
  return true;
}

function switchTo(identity) {
  if (active && active !== identity) previous = active;
  active = identity;
  if (identity?.me?.branchId) remember({ branchId: identity.me.branchId });
  log(c.bold(c.green(`active identity: ${describe(identity)}`)));
  if (observer && observer.as !== identity?.username) log(c.dim(`(observer still runs as ${observer.as}; o twice to reconnect as ${identity?.username})`));
}

const describe = (i) => (i ? `${i.username} ${i.me.role} (scope ${i.scope}${i.me.branchId ? `, branch ${i.me.branchId}` : ', all branches'})` : 'none (logged out)');

async function loginAs() {
  const saved = [...identities.values()];
  if (saved.length) {
    saved.forEach((i, n) => log(`  ${n + 1}. ${describe(i)}${i === active ? c.dim('  <- active') : ''}`));
    log('  n. new login');
    const pick = await ask('identity #', 'n');
    const chosen = saved[Number(pick) - 1];
    if (chosen) return switchTo(chosen);
  }
  log(c.dim('seed users: hq-admin / change-me-immediately, manager.manar, employee.manar1, gamer.wood ... (password123)'));
  const username = await ask('username', 'gamer.wood');
  const password = await ask('password', 'password123');
  if (!(await login(username, password))) log(c.red('login failed'));
}

function swap() {
  if (!previous) return log(c.yellow('no previous identity: l to log in as another profile'));
  switchTo(previous);
}

// ---------------------------------------------------------------- observer (/dashboard-io)

let observer = null;
let showTelemetry = false;

const EVENT_COLOR = {
  station_status: c.cyan,
  command_update: c.yellow,
  command_result: c.yellow,
  catalog_status: c.cyan,
  alert: c.red,
  alert_resolved: c.green,
  session_update: c.magenta,
  session_runout_warning: (s) => c.bold(c.magenta(s)),
  telemetry_update: c.dim,
};

function toggleObserver() {
  if (observer) {
    observer.close();
    observer = null;
    return log(c.dim('[observer] off'));
  }
  if (!active) return log(c.yellow('log in first: the observer authenticates with the active identity'));
  const identity = active;
  observer = io(BASE_URL, {
    path: '/dashboard-io',
    // A function, so every reconnect sends the identity's current (refreshed) token.
    auth: (cb) => cb({ token: identity.accessToken }),
    transports: ['websocket'],
  });
  observer.as = identity.username;
  observer.on('connect', () => log(c.dim(`[${stamp()}] [observer] connected as ${identity.username}`)));
  observer.on('connect_error', (err) => log(c.red(`[${stamp()}] [observer] connect error: ${err.message}`)));
  observer.on('disconnect', (reason) => log(c.yellow(`[${stamp()}] [observer] disconnected: ${reason}`)));
  observer.onAny((event, payload) => {
    if (event === 'telemetry_update' && !showTelemetry) return;
    const color = EVENT_COLOR[event] ?? ((s) => s);
    log(`${c.dim(`[${stamp()}]`)} ${color(`[${event}]`)} ${JSON.stringify(payload)}`);
  });
}

// ---------------------------------------------------------------- prompts for common ids

const askBranch = () => ask('branchId', ctx.branchId ?? active?.me?.branchId);
const askStation = () => ask('stationId (= machineId)', ctx.stationId);
const askGamerProfile = () => ask('gamerProfileId', ctx.gamerProfileId);

// ---------------------------------------------------------------- Secure Access

async function whoami() {
  const res = await http('GET', '/auth/me');
  if (res.ok && active) active.me = res.data;
}

async function refreshTokens() {
  if (await renew(active)) log(c.green(`new token pair for ${active.username}`));
}

async function logout() {
  const res = await http('POST', '/auth/logout', { body: { refreshToken: active.refreshToken } });
  if (!res.ok) return;
  identities.delete(active.username);
  const next = previous && identities.has(previous.username) ? previous : null;
  previous = null;
  active = null;
  switchTo(next);
}

async function registerGamer() {
  const username = await ask('username', `gamer-${Date.now().toString(36)}`);
  const password = await ask('password', 'gamer-pass-123');
  const res = await http('POST', '/users', { body: { username, password }, token: null });
  if (res.ok) {
    remember({ userId: res.data.id });
    if (await confirm(`log in as ${username} now?`)) await login(username, password);
  }
}

async function createEmployee() {
  const body = {
    username: await ask('username', `staff-${Date.now().toString(36)}`),
    password: await ask('password', 'staff-pass-123'),
    role: (await ask('role EMPLOYEE|MANAGER', 'EMPLOYEE')).toUpperCase(),
    branchId: await askBranch(),
  };
  const res = await http('POST', '/employees', { body });
  if (res.ok) remember({ userId: res.data.id });
}

async function changeRole() {
  const id = await ask('user id', ctx.userId);
  const role = (await ask('role GAMER|EMPLOYEE|MANAGER|ADMIN', 'EMPLOYEE')).toUpperCase();
  const branchId = await ask('branchId (empty = not sent, "null" = clear)', ['EMPLOYEE', 'MANAGER'].includes(role) ? ctx.branchId : '');
  await http('PATCH', `/users/${id}/role`, { body: compact({ role, branchId: branchId === 'null' ? null : branchId }) });
}

async function getUser() {
  await http('GET', `/users/${await ask('user id', ctx.userId ?? active?.me?.id)}`);
}

// ---------------------------------------------------------------- Node Tracking

async function listStations() {
  const res = await http('GET', '/api/v1/stations');
  if (res.ok && Array.isArray(res.data) && res.data[0]) remember({ stationId: ctx.stationId ?? res.data[0].id });
}

async function getStation() {
  const res = await http('GET', `/api/v1/stations/${await askStation()}`);
  if (res.ok) remember({ stationId: res.data.id, branchId: res.data.branchId });
}

async function listMachines() {
  const query = new URLSearchParams(
    compact({
      branchId: await ask('branchId filter (empty = all you may see)', ''),
      status: (await ask('status filter PENDING|ENROLLED|INACTIVE|DEACTIVATED (empty = all)', '')).toUpperCase(),
    }),
  ).toString();
  const res = await http('GET', `/machines${query ? `?${query}` : ''}`);
  if (res.ok && Array.isArray(res.data)) {
    const branches = [...new Set(res.data.map((m) => m.branchId))];
    log(c.dim(`${res.data.length} machine(s); branch ids seen: ${branches.join(', ') || '-'}`));
    if (!ctx.branchId && branches[0]) remember({ branchId: branches[0] });
  }
}

async function getMachine() {
  const res = await http('GET', `/machines/${await askStation()}`);
  if (res.ok) remember({ stationId: res.data.id, branchId: res.data.branchId });
}

/** Same read with every logged-in identity, to show branch scoping side by side. */
async function scopeCompare() {
  const path = await ask('path', '/machines');
  for (const identity of identities.values()) {
    log(c.bold(`\n== as ${describe(identity)}`));
    const res = await http('GET', path, { token: identity.accessToken });
    if (res.ok && Array.isArray(res.data)) log(c.dim(`${res.data.length} row(s)`));
  }
}

// ---------------------------------------------------------------- Station Provisioning / Enrollment
//
// A stand-in agent enrolls exactly like the real one: a generated P-256 key,
// the canonical string signed with ECDSA-SHA256 (DER), POST /enrollment/request
// polled until an admin approves. Keys live only in this process.

/** serial -> { serial, name, mac, ip, publicKey (b64 DER SPKI), privateKey, lastSignedAt, machineId, branchId, stationToken } */
const standIns = new Map();

function newKeys(standIn) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  standIn.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  standIn.privateKey = privateKey;
  standIn.lastSignedAt = 0;
}

function standInFor(serial) {
  let standIn = standIns.get(serial);
  if (!standIn) {
    const mac = [...randomBytes(6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
    standIn = { serial, name: serial, mac, ip: '127.0.0.1', machineId: null, branchId: null, stationToken: null };
    newKeys(standIn);
    standIns.set(serial, standIn);
  }
  return standIn;
}

/** The signed redeem body (canonical string: enrollment.service.ts isValidEnrollmentSignature). */
function enrollmentRequest(standIn, oneTimeToken) {
  // Each poll must be signed later than the previous one on the same token.
  const signedAt = Math.max(Date.now(), standIn.lastSignedAt + 1);
  standIn.lastSignedAt = signedAt;
  const canonical = ['BARONDESK-ENROLL-V1', oneTimeToken, standIn.serial, standIn.mac, standIn.ip, standIn.publicKey, signedAt].join('\n');
  const signature = sign('sha256', Buffer.from(canonical, 'utf8'), { key: standIn.privateKey, dsaEncoding: 'der' }).toString('base64');
  return {
    oneTimeToken,
    serialNumber: standIn.serial,
    machineName: standIn.name,
    agentVersion: 'station-console-standin',
    agentPublicKey: standIn.publicKey,
    mac: standIn.mac,
    ip: standIn.ip,
    signedAt,
    signature,
  };
}

async function redeem(standIn, oneTimeToken) {
  const res = await http('POST', '/enrollment/request', { body: enrollmentRequest(standIn, oneTimeToken), token: null });
  const data = res.data ?? {};
  if (data.machineId) {
    standIn.machineId = data.machineId;
    remember({ stationId: data.machineId });
  }
  if (data.status === 'ENROLLED') {
    standIn.stationToken = data.stationToken;
    log(c.green(`stand-in ${standIn.serial} ENROLLED, station token stored (${data.stationToken.length} chars)`));
  }
  if (data.status === 'REJECTED') log(c.red(`REJECTED: ${data.reason}`));
  return data;
}

async function mintEnrollmentToken() {
  const body = { branchId: await askBranch(), ttlMinutes: await askNum('ttlMinutes (max 1440)', 60) };
  const res = await http('POST', '/machines/enrollment-tokens', { body });
  if (!res.ok) return null;
  remember({ enrollmentToken: res.data.token, branchId: body.branchId });
  log(c.bold(`\n    ENROLLMENT TOKEN (${res.data.token.length} chars): ${res.data.token}\n`));
  log(c.dim('Real agent: give it this token (the agent must run elevated or as the SYSTEM service).'));
  log(c.dim('Stand-in: run "stand-in: redeem" with it. Then approve the PENDING machine.'));
  return { token: res.data.token, branchId: body.branchId };
}

async function redeemCommand() {
  const serial = await ask('stand-in serial', [...standIns.keys()].at(-1) ?? `STANDIN-${randomUUID().slice(0, 6).toUpperCase()}`);
  const exists = standIns.has(serial);
  const standIn = standInFor(serial);
  if (exists && (await confirm('generate a new key pair (use for a rotate-token redeem)?'))) newKeys(standIn);
  await redeem(standIn, await ask('one-time token', ctx.enrollmentToken));
}

async function machineAction(action) {
  const id = await ask('machineId', ctx.stationId);
  if (action === 'revoke' && !(await confirm(`revoke ${id}? (DEACTIVATED; no REST route undoes it)`))) return;
  const res = await http('POST', `/machines/${id}/${action}`);
  if (res.ok) remember({ stationId: res.data.id, branchId: res.data.branchId });
}

async function rotateToken() {
  const res = await http('POST', `/machines/${await ask('machineId', ctx.stationId)}/rotate-token`);
  if (res.ok) {
    remember({ enrollmentToken: res.data.token });
    log(c.bold(`\n    ROTATION TOKEN: ${res.data.token}\n`));
    log(c.dim('Redeem it with the same serial (stand-in: redeem, new key pair y) to swap the credential.'));
  }
}

/** mint -> redeem (PENDING) -> approve -> redeem (ENROLLED + station token). Each step is a plain call, printed. */
async function provisionStandIn() {
  const serial = await ask('stand-in serial', `STANDIN-${randomUUID().slice(0, 6).toUpperCase()}`);
  const minted = await mintEnrollmentToken();
  if (!minted) return;
  const standIn = standInFor(serial);
  standIn.branchId = minted.branchId;
  const first = await redeem(standIn, minted.token);
  if (first.status !== 'PENDING') return log(c.yellow(`expected PENDING, got ${first.status}: stopped`));
  const approved = await http('POST', `/machines/${first.machineId}/approve`);
  if (!approved.ok) return;
  await redeem(standIn, minted.token);
}

function listStandIns() {
  if (standIns.size === 0) return log(c.dim('no stand-ins yet (provision one, or redeem a token)'));
  for (const s of standIns.values()) {
    log(`${c.bold(s.serial)}  machine ${s.machineId ?? '-'}  mac ${s.mac}`);
    log(s.stationToken ? `  stationToken: ${s.stationToken}` : c.dim('  no station token yet'));
  }
}

async function agentCatalogPull() {
  const serial = await ask('stand-in serial (empty = paste a station token)', [...standIns.values()].find((s) => s.stationToken)?.serial ?? '');
  const token = serial ? standIns.get(serial)?.stationToken : await ask('station token');
  if (!token) return log(c.red('no station token for that serial'));
  await http('GET', '/stations/me/games', { token });
}

// ---------------------------------------------------------------- negative admission cases (FORGERIES)
//
// Everything below forges what the backend never hands out: station JWTs
// signed with JWT_ACCESS_SECRET (ghost machine, moved branch, expired) and
// direct `enrollment_status` writes through psql. Test-only, to prove the
// backend refuses them. Needs Docker and the repo root as working directory.

const COMPOSE = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml'];
let jwtSecret = null;

function psql(sql) {
  log(c.magenta(`[FORGERY psql] ${sql}`));
  execFileSync('docker', [...COMPOSE, 'exec', '-T', 'postgres', 'psql', '-U', 'cstam', '-d', 'cstam', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function accessSecret() {
  if (jwtSecret) return jwtSecret;
  try {
    jwtSecret = execFileSync('docker', [...COMPOSE, 'exec', '-T', 'backend', 'printenv', 'JWT_ACCESS_SECRET'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    const line = existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith('JWT_ACCESS_SECRET=')) : undefined;
    jwtSecret = line?.slice('JWT_ACCESS_SECRET='.length).trim().replace(/^["']|["']$/g, '');
  }
  if (!jwtSecret) throw new Error('JWT_ACCESS_SECRET not found (backend container down and not in ./.env)');
  return jwtSecret;
}

/** FORGED station JWT (HS256, same claims enrollment signs). Never a real credential. */
function forgeStationToken({ id, serialNumber, branchId }, ttlSeconds) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, type: 'station', serialNumber, branchId, iat: now, exp: now + ttlSeconds })}`;
  return `${body}.${createHmac('sha256', accessSecret()).update(body).digest('base64url')}`;
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

/** 'open' if the socket is still up after 750 ms, else the close code or the upgrade's HTTP status. */
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

/** Handshakes as `serial`: 'ack', or the close code. */
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

async function admissionCases() {
  const withToken = [...standIns.values()].filter((s) => s.stationToken);
  if (withToken.length === 0) return log(c.yellow('needs a stand-in with a station token: provision one first'));
  const serial = await ask('stand-in serial', withToken.at(-1).serial);
  const standIn = standIns.get(serial);
  if (!standIn?.stationToken) return log(c.red('that stand-in has no station token'));
  const row = await http('GET', `/machines/${standIn.machineId}`);
  if (!row.ok) return;
  const machine = { id: row.data.id, serialNumber: row.data.serialNumber, branchId: row.data.branchId };
  const original = row.data.enrollmentStatus;
  const valid = standIn.stationToken;
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });

  let failed = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    log(`${ok ? c.green('PASS') : c.red('FAIL')}  ${label.padEnd(64)} got ${actual}, want ${expected}`);
  };
  log(c.bold(`\nadmission cases for stand-in ${serial} (machine ${machine.id}, ${original})`));
  log(c.magenta('Cases b to e use FORGED tokens and direct DB writes. They exist only to prove the backend refuses them.\n'));

  try {
    check('a. real station token, ENROLLED: /agent-ws stays open', await admission(valid), 'open');
    check('a. real station token, ENROLLED: GET /stations/me/games', await catalogStatus(bearer(valid)), 200);

    for (const status of ['PENDING', 'INACTIVE', 'DEACTIVATED']) {
      psql(`UPDATE machines SET enrollment_status = '${status}', updated_at = now() WHERE id = '${machine.id}'`);
      check(`b. [forged row status] ${status}: /agent-ws close code`, await admission(valid), 1008);
      check(`b. [forged row status] ${status}: GET /stations/me/games`, await catalogStatus(bearer(valid)), 403);
    }
    psql(`UPDATE machines SET enrollment_status = '${original}', updated_at = now() WHERE id = '${machine.id}'`);

    const ghostId = randomUUID();
    const ghost = forgeStationToken({ id: ghostId, serialNumber: `GHOST-${ghostId.slice(0, 8)}`, branchId: machine.branchId }, 300);
    check('c. [forged token] no MACHINE row: /agent-ws close code', await admission(ghost), 1008);
    check('c. [forged token] no MACHINE row: handshake close code', await handshakeResult(ghost, `GHOST-${ghostId.slice(0, 8)}`), 1008);
    check('c. [forged token] no MACHINE row: GET /stations/me/games', await catalogStatus(bearer(ghost)), 403);
    check('c. no MACHINE row created (GET /machines/:id)', (await http('GET', `/machines/${ghostId}`)).status, 404);

    const moved = forgeStationToken({ ...machine, branchId: randomUUID() }, 300);
    check('d. [forged token] branch != row: /agent-ws close code', await admission(moved), 1008);
    check('d. [forged token] branch != row: GET /stations/me/games', await catalogStatus(bearer(moved)), 401);
    check('d. real token, handshake serial != token serial: close code', await handshakeResult(valid, `${machine.serialNumber}-X`), 1008);

    const expired = forgeStationToken(machine, -60);
    const unknownSerial = `UNKNOWN-${randomUUID().slice(0, 8)}`;
    check('e. no token: WSS upgrade', await upgradeStatus(null), 401);
    check('e. no token: GET /stations/me/games', await catalogStatus({}), 401);
    check('e. ?serialNumber= only: GET /stations/me/games', await catalogStatus({}, `?serialNumber=${unknownSerial}`), 401);
    check('e. x-station-serial only: GET /stations/me/games', await catalogStatus({ 'x-station-serial': machine.serialNumber }), 401);
    check('e. garbage token: WSS upgrade', await upgradeStatus('garbage'), 401);
    check('e. [forged token] expired: WSS upgrade', await upgradeStatus(expired), 401);
    check('e. [forged token] expired: GET /stations/me/games', await catalogStatus(bearer(expired)), 401);
    check('e. user access token: WSS upgrade', await upgradeStatus(active.accessToken), 401);
    check('e. user access token: GET /stations/me/games', await catalogStatus(bearer(active.accessToken)), 401);
    const all = await http('GET', '/machines');
    check('e. no MACHINE row auto-created for the unknown serial', (all.data ?? []).some((m) => m.serialNumber === unknownSerial), false);
  } catch (err) {
    failed++;
    log(c.red(`aborted: ${err.message}`));
    try {
      psql(`UPDATE machines SET enrollment_status = '${original}', updated_at = now() WHERE id = '${machine.id}'`);
    } catch {
      log(c.red(`could not restore enrollment_status: set it back to ${original} by hand`));
    }
  }
  log(`\n${failed ? c.red(`${failed} failed`) : c.green('all passed')}  ${c.dim(`(enrollment_status back to ${original})`)}`);
}

// ---------------------------------------------------------------- Games Catalog

async function createGame() {
  const launchType = await ask('launchType exe|steam|epic', 'exe');
  const d = {
    exe: { gameId: 'notepad', name: 'Notepad', target: 'C:\\Windows\\System32\\notepad.exe', processName: 'notepad.exe' },
    steam: { gameId: 'cs2', name: 'Counter-Strike 2', target: '730', processName: 'cs2.exe' },
    epic: { gameId: 'fortnite', name: 'Fortnite', target: 'Fortnite', processName: 'FortniteClient-Win64-Shipping.exe' },
  }[launchType] ?? {};
  const body = compact({
    launchType,
    gameId: await ask('gameId (wire id)', d.gameId),
    name: await ask('name', d.name),
    target: await ask('target', d.target),
    processName: await ask('processName (empty = none)', d.processName ?? ''),
    arguments: await ask('arguments (empty = none)', ''),
  });
  const res = await http('POST', '/api/v1/games', { body });
  if (res.ok) remember({ gameId: res.data.id });
}

async function updateGame() {
  const id = await ask('game id (uuid)', ctx.gameId);
  await http('PATCH', `/api/v1/games/${id}`, { body: await askJson('JSON patch', '{"enabled":false}') });
}

async function gameBranch(method) {
  await http(method, `/api/v1/games/${await ask('game id (uuid)', ctx.gameId)}/branches/${await askBranch()}`);
}

async function gameStation(method) {
  const id = await ask('game id (uuid)', ctx.gameId);
  const stationId = await askStation();
  const body = method === 'PUT' ? await askJson('overrides JSON (target / arguments / workingDirectory)', '{}') : undefined;
  await http(method, `/api/v1/games/${id}/stations/${stationId}`, { body });
}

// ---------------------------------------------------------------- Remote Admin

async function sendCommand() {
  const stationId = await askStation();
  const type = (await ask('type LOCK|UNLOCK|END_SESSION|SHUTDOWN|LAUNCH_GAME|CATALOG_UPDATE', 'LOCK')).toUpperCase();
  if (type === 'SHUTDOWN' && !(await confirm('SHUTDOWN the station?'))) return;
  const body = { type };
  if (type === 'LAUNCH_GAME') body.gameId = await ask('gameId (wire id)', 'notepad');
  if (type === 'END_SESSION') Object.assign(body, compact({ reason: await ask('reason (empty = agent default "normal")', '') }));
  Object.assign(body, compact({ simulate: await ask('simulate (dev) stale_ts|duplicate_send|invalid_payload|exec_failed, empty = none', '') }));
  const res = await http('POST', `/api/v1/stations/${stationId}/commands`, { body });
  if (res.ok) remember({ commandId: res.data.commandId, stationId });
  if (res.ok) log(c.dim('final status arrives as [command_update] in the observer, or with "get command"'));
}

// ---------------------------------------------------------------- Telemetry & alerts

async function listAlerts() {
  const query = new URLSearchParams(
    compact({ status: await ask('status open|resolved (empty = all)', 'open'), branchId: await ask('branchId (empty = all you may see)', ''), limit: await ask('limit', 20) }),
  );
  const res = await http('GET', `/api/v1/alerts?${query}`);
  const rows = Array.isArray(res.data) ? res.data : (res.data?.items ?? []);
  if (rows[0]) remember({ alertId: rows[0].id });
}

// ---------------------------------------------------------------- Sessions

async function createSession() {
  const res = await http('POST', '/sessions', { body: { reservationId: await ask('reservationId', ctx.reservationId) } });
  if (!res.ok) return;
  remember({ sessionId: res.data.id });
  log(c.bold(c.yellow(`\n    PIN: ${res.data.pin}   (shown once: type it on the station lock screen)\n`)));
}

// ---------------------------------------------------------------- Wallet

async function walletMe() {
  const res = await http('GET', '/wallets/me');
  if (res.ok) remember({ gamerProfileId: res.data.gamerProfileId });
}

async function walletMove(kind) {
  const gamerProfileId = await askGamerProfile();
  const body = compact({
    amount: await askNum('amount (integer, minor units)', 10000),
    type: (await ask('type PAYMENT|REFUND|ADJUSTMENT|CREDIT|DEBIT (empty = default)', '')).toUpperCase(),
    idempotencyKey: await ask('idempotencyKey (empty = none; reuse one to test dedupe)', ''),
  });
  await http('POST', `/wallets/${gamerProfileId}/${kind}`, { body });
}

// ---------------------------------------------------------------- Subscription & Membership

async function createPlan(kind) {
  const body = {
    name: await ask('name', `${kind === 'membership' ? 'Gold' : 'Night owl'} ${Date.now().toString(36)}`),
    price: await askNum('price (currency units)', 5),
    durationDays: await askNum('durationDays', 30),
  };
  if (kind === 'membership') {
    body.discountPercent = await askNum('discountPercent', 50);
    body.bookingAdvanceDays = await askNum('bookingAdvanceDays', 7);
  } else {
    body.benefits = await askJson('benefits JSON', '{"windows":[{"daysOfWeek":[0,1,2,3,4,5,6],"startTime":"00:00","endTime":"23:59","discountPercent":20}]}');
  }
  const res = await http('POST', `/${kind}-plans`, { body });
  if (res.ok) remember({ [`${kind}PlanId`]: res.data.id });
}

async function updatePlan(kind) {
  const id = await ask('plan id', ctx[`${kind}PlanId`]);
  await http('PATCH', `/${kind}-plans/${id}`, { body: await askJson('JSON patch', kind === 'membership' ? '{"discountPercent":25}' : '{"price":10}') });
}

async function deletePlan(kind) {
  await http('DELETE', `/${kind}-plans/${await ask('plan id', ctx[`${kind}PlanId`])}`);
}

async function purchasePlan(kind) {
  const id = await ask('plan id', ctx[`${kind}PlanId`]);
  const key = await ask('idempotencyKey (empty = none; reuse to test dedupe)', '');
  await http('POST', `/${kind}-plans/${id}/purchase`, { body: compact({ idempotencyKey: key }) });
}

async function listPlans(kind) {
  const res = await http('GET', `/${kind}-plans`);
  if (res.ok && Array.isArray(res.data) && res.data[0]) remember({ [`${kind}PlanId`]: ctx[`${kind}PlanId`] ?? res.data[0].id });
}

// ---------------------------------------------------------------- Advance Reservation

/** No default: the operator types the time. Re-asks until something is typed; the backend validates it. */
async function askTime(label) {
  for (;;) {
    const value = await ask(`${label} (ISO with offset, e.g. ${new Date().toISOString().slice(0, 16)}:00Z or 2026-10-01T18:00:00+01:00)`);
    if (value) return value;
  }
}

async function createReservation() {
  log(c.dim(`now: ${new Date().toISOString()} (UTC). startTime must be in the future.`));
  const body = {
    machineId: await askStation(),
    startTime: await askTime('startTime'),
    endTime: await askTime('endTime'),
  };
  const res = await http('POST', '/reservations', { body });
  if (res.ok) remember({ reservationId: res.data.id });
}

async function walkIn() {
  const body = { machineId: await askStation(), durationMinutes: await askNum('durationMinutes', 60) };
  const res = await http('POST', '/reservations/walk-in', { body });
  if (res.ok) remember({ reservationId: res.data.id });
}

// ---------------------------------------------------------------- Pricing

async function setPricing() {
  const branchId = await askBranch();
  const body = { paygRate: await askNum('paygRate (integer per hour)', 6000), bookingRate: await askNum('bookingRate (integer per hour)', 6000) };
  await http('PUT', `/branches/${branchId}/pricing`, { body });
}

// ---------------------------------------------------------------- raw request

async function rawRequest() {
  const method = (await ask('method', 'GET')).toUpperCase();
  const path = await ask('path', '/auth/me');
  const body = await askJson('JSON body (empty = none)', '');
  const tokenChoice = await ask('token: a = active, n = none, s = stand-in station token', 'a');
  const token = tokenChoice === 'n' ? null : tokenChoice === 's' ? [...standIns.values()].find((s) => s.stationToken)?.stationToken : active?.accessToken;
  await http(method, path, { body, token });
}

// ---------------------------------------------------------------- the palette

/** [group, label, min scope, run]. Numbers follow this order and never change between profiles. */
const COMMANDS = [
  ['Secure Access', 'login as another profile (POST /auth/login)', 'public', loginAs],
  ['Secure Access', 'whoami (GET /auth/me)', 'self', whoami],
  ['Secure Access', 'refresh tokens (POST /auth/refresh)', 'self', refreshTokens],
  ['Secure Access', 'logout (POST /auth/logout)', 'self', logout],
  ['Secure Access', 'register a gamer (POST /users)', 'public', registerGamer],
  ['Secure Access', 'create EMPLOYEE / MANAGER (POST /employees)', 'admin', createEmployee],
  ['Secure Access', "change a user's role (PATCH /users/:id/role)", 'admin', changeRole],
  ['Secure Access', 'get a user (GET /users/:id)', 'self', getUser],

  ['Node Tracking', 'list stations (GET /api/v1/stations)', 'staff', listStations],
  ['Node Tracking', 'get station (GET /api/v1/stations/:id)', 'staff', getStation],
  ['Node Tracking', 'list machines (GET /machines)', 'staff', listMachines],
  ['Node Tracking', 'get machine (GET /machines/:id)', 'staff', getMachine],
  ['Node Tracking', 'same GET as every logged-in identity (branch scoping)', 'self', scopeCompare],

  ['Station Provisioning', 'mint one-time enrollment token (POST /machines/enrollment-tokens)', 'admin', mintEnrollmentToken],
  ['Station Provisioning', 'stand-in: redeem a token (POST /enrollment/request, signed)', 'public', redeemCommand],
  ['Station Provisioning', 'approve machine (POST /machines/:id/approve)', 'admin', () => machineAction('approve')],
  ['Station Provisioning', 'reject machine (POST /machines/:id/reject)', 'admin', () => machineAction('reject')],
  ['Station Provisioning', 'revoke machine (POST /machines/:id/revoke)', 'admin', () => machineAction('revoke')],
  ['Station Provisioning', 'rotate credential (POST /machines/:id/rotate-token)', 'admin', rotateToken],
  ['Station Provisioning', 'stand-in: provision end to end (mint, redeem, approve, redeem)', 'admin', provisionStandIn],
  ['Station Provisioning', 'stand-ins: list (serial, machine, station token)', 'public', listStandIns],
  ['Station Provisioning', 'negative admission cases (FORGED tokens + psql writes)', 'admin', admissionCases],

  ['Games Catalog', 'list games (GET /api/v1/games)', 'self', () => http('GET', '/api/v1/games')],
  ['Games Catalog', 'create game (POST /api/v1/games)', 'admin', createGame],
  ['Games Catalog', 'update game (PATCH /api/v1/games/:id)', 'admin', updateGame],
  ['Games Catalog', 'attach to branch (PUT /api/v1/games/:id/branches/:branchId)', 'admin', () => gameBranch('PUT')],
  ['Games Catalog', 'detach from branch (DELETE .../branches/:branchId)', 'admin', () => gameBranch('DELETE')],
  ['Games Catalog', 'attach to station (PUT /api/v1/games/:id/stations/:stationId)', 'admin', () => gameStation('PUT')],
  ['Games Catalog', 'detach from station (DELETE .../stations/:stationId)', 'admin', () => gameStation('DELETE')],
  ['Games Catalog', "station's games (GET /api/v1/stations/:id/games)", 'staff', async () => http('GET', `/api/v1/stations/${await askStation()}/games`)],
  ['Games Catalog', 'agent catalog pull (GET /stations/me/games, station token)', 'station', agentCatalogPull],

  ['Remote Admin', 'send command (POST /api/v1/stations/:id/commands)', 'staff', sendCommand],
  ['Remote Admin', 'list commands (GET /api/v1/stations/:id/commands)', 'staff', async () => http('GET', `/api/v1/stations/${await askStation()}/commands?limit=${await ask('limit', 10)}`)],
  ['Remote Admin', 'get command (GET /api/v1/commands/:commandId)', 'staff', async () => http('GET', `/api/v1/commands/${await ask('commandId', ctx.commandId)}`)],

  ['Telemetry & Anti-Theft', 'station telemetry (GET /api/v1/stations/:id/telemetry)', 'staff', async () => http('GET', `/api/v1/stations/${await askStation()}/telemetry`)],
  ['Telemetry & Anti-Theft', 'list alerts (GET /api/v1/alerts)', 'staff', listAlerts],
  ['Telemetry & Anti-Theft', 'resolve alert (POST /api/v1/alerts/:id/resolve)', 'staff', async () => http('POST', `/api/v1/alerts/${await ask('alert id', ctx.alertId)}/resolve`)],

  ['Session & Financial Control', 'create session -> PIN (POST /sessions)', 'staff', createSession],
  ['Session & Financial Control', 'get session (GET /sessions/:id)', 'staff', async () => http('GET', `/sessions/${await ask('sessionId', ctx.sessionId)}`)],
  ['Session & Financial Control', 'end session (POST /sessions/:id/end)', 'staff', async () => http('POST', `/sessions/${await ask('sessionId', ctx.sessionId)}/end`, { body: compact({ reason: await ask('reason (empty = none)', 'staff_end') }) })],

  ['Electronic Wallet', 'my wallet (GET /wallets/me)', 'self', walletMe],
  ['Electronic Wallet', 'my ledger (GET /wallets/me/entries)', 'self', async () => http('GET', `/wallets/me/entries?take=${await ask('take', 20)}`)],
  ['Electronic Wallet', 'wallet of a gamer (GET /wallets/:gamerProfileId)', 'staff', async () => http('GET', `/wallets/${await askGamerProfile()}`)],
  ['Electronic Wallet', 'ledger of a gamer (GET /wallets/:gamerProfileId/entries)', 'staff', async () => http('GET', `/wallets/${await askGamerProfile()}/entries?take=${await ask('take', 20)}`)],
  ['Electronic Wallet', 'credit / top up (POST /wallets/:gamerProfileId/credit)', 'staff', () => walletMove('credit')],
  ['Electronic Wallet', 'debit (POST /wallets/:gamerProfileId/debit)', 'staff', () => walletMove('debit')],

  ['Subscription & Membership', 'list membership plans (GET /membership-plans)', 'self', () => listPlans('membership')],
  ['Subscription & Membership', 'create membership plan (POST /membership-plans)', 'admin', () => createPlan('membership')],
  ['Subscription & Membership', 'update membership plan (PATCH /membership-plans/:id)', 'admin', () => updatePlan('membership')],
  ['Subscription & Membership', 'delete membership plan (DELETE /membership-plans/:id)', 'admin', () => deletePlan('membership')],
  ['Subscription & Membership', 'my memberships (GET /memberships/me)', 'self', () => http('GET', '/memberships/me')],
  ['Subscription & Membership', 'buy a membership (POST /membership-plans/:id/purchase)', 'self', () => purchasePlan('membership')],
  ['Subscription & Membership', 'list subscription plans (GET /subscription-plans)', 'self', () => listPlans('subscription')],
  ['Subscription & Membership', 'create subscription plan (POST /subscription-plans)', 'admin', () => createPlan('subscription')],
  ['Subscription & Membership', 'update subscription plan (PATCH /subscription-plans/:id)', 'admin', () => updatePlan('subscription')],
  ['Subscription & Membership', 'delete subscription plan (DELETE /subscription-plans/:id)', 'admin', () => deletePlan('subscription')],
  ['Subscription & Membership', 'my subscriptions (GET /subscriptions/me)', 'self', () => http('GET', '/subscriptions/me')],
  ['Subscription & Membership', 'buy a subscription (POST /subscription-plans/:id/purchase)', 'self', () => purchasePlan('subscription')],

  ['Advance Reservation', 'my reservations (GET /reservations)', 'self', () => http('GET', '/reservations')],
  ['Advance Reservation', 'book ahead (POST /reservations)', 'self', createReservation],
  ['Advance Reservation', 'walk-in, starts now (POST /reservations/walk-in)', 'self', walkIn],
  ['Advance Reservation', 'cancel (DELETE /reservations/:id)', 'self', async () => http('DELETE', `/reservations/${await ask('reservationId', ctx.reservationId)}`)],

  ['Multi-Agency & Pricing', 'branch pricing (GET /branches/:branchId/pricing)', 'staff', async () => http('GET', `/branches/${await askBranch()}/pricing`)],
  ['Multi-Agency & Pricing', 'set branch pricing (PUT /branches/:branchId/pricing)', 'admin', setPricing],
].map(([group, label, min, run], n) => ({ n: n + 1, group, label, min, run }));

const allowed = (cmd) => cmd.min === 'station' || can(cmd.min);

function showPalette(filter = '') {
  const needle = filter.toLowerCase();
  log(`\n${c.bold(`Palette for ${describe(active)}`)}${observer ? c.dim(`  | observer on (as ${observer.as})`) : ''}`);
  let group = null;
  for (const cmd of COMMANDS) {
    if (needle && !`${cmd.group} ${cmd.label}`.toLowerCase().includes(needle)) continue;
    const ok = allowed(cmd);
    if (!ok && !showLocked) continue;
    if (cmd.group !== group) {
      group = cmd.group;
      log(c.bold(`\n  ${group}`));
    }
    const num = String(cmd.n).padStart(4);
    log(ok ? `${num}  ${cmd.label}` : c.dim(`${num}  ${cmd.label}  (requires ${cmd.min})`));
  }
  log(c.dim('\n  l login as   s swap identity   o observer   t telemetry frames   v show locked   c ids   r raw   /text filter   h palette   q quit'));
}

function showContext() {
  log(c.bold('remembered ids (prompt defaults):'));
  for (const [key, value] of Object.entries(ctx)) log(`  ${key.padEnd(20)} ${value}`);
  if (Object.keys(ctx).length === 0) log(c.dim('  none yet'));
}

async function main() {
  log(c.bold(`Station console -> ${BASE_URL}`));
  if (FIRST_USER) await login(FIRST_USER, FIRST_PASS);
  showPalette();

  for (;;) {
    const input = (await ask(`\n${c.bold(active ? `${active.username}/${active.scope}` : 'logged out')} >`)).trim();
    const key = input.toLowerCase();
    try {
      if (key === '' || key === 'h' || key === '?') showPalette();
      else if (key === 'q') break;
      else if (key === 'l') await loginAs();
      else if (key === 's') swap();
      else if (key === 'o') toggleObserver();
      else if (key === 't') log(c.dim(`[observer] telemetry frames ${(showTelemetry = !showTelemetry) ? 'shown' : 'hidden'}`));
      else if (key === 'v') {
        showLocked = !showLocked;
        showPalette();
      }
      else if (key === 'c') showContext();
      else if (key === 'r') await rawRequest();
      else if (input.startsWith('/')) showPalette(input.slice(1));
      else {
        const cmd = COMMANDS.find((x) => String(x.n) === key);
        if (!cmd) {
          log(c.yellow('unknown key: h for the palette'));
          continue;
        }
        if (!allowed(cmd) && !(await confirm(`"${cmd.label}" requires ${cmd.min}; you are ${scope()}. Send anyway (expect 401/403)?`))) continue;
        log(c.bold(`\n== ${cmd.n}. ${cmd.label}`));
        await cmd.run();
      }
    } catch (err) {
      log(c.red(`error: ${err.message}`));
    }
  }
}

main()
  .catch((err) => log(c.red(err.stack ?? err.message)))
  .finally(() => {
    observer?.close();
    rl.close();
  });

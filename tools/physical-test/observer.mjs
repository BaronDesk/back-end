// Physical test observer: listens on /dashboard-io and prints every frame the
// backend emits. It only logs; it never computes or asserts anything.
//
//   node tools/physical-test/observer.mjs
//
// Env (all optional):
//   BASE_URL        backend REST base, used for the admin login   (default http://localhost:3000)
//   WS_URL          Socket.IO origin                               (default BASE_URL)
//   ADMIN_USERNAME  / ADMIN_PASSWORD                               (default hq-admin / change-me-immediately)
//   HIDE_EVENTS     comma list of events to hide, e.g. telemetry_update

import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const WS_URL = process.env.WS_URL ?? BASE_URL;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'hq-admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-me-immediately';
const HIDE_EVENTS = new Set((process.env.HIDE_EVENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(`[${ts()}]`, ...args);

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(body)}`);
  return body.accessToken;
}

const BANNER = {
  session_runout_warning: '>>>>>>>>>> SESSION_RUNOUT_WARNING <<<<<<<<<<',
  station_status: '---------- station_status',
  session_update: '---------- session_update',
  command_update: '---------- command_update',
  command_result: '---------- command_result',
};

async function main() {
  log(`logging in as ${ADMIN_USERNAME} at ${BASE_URL}`);
  const token = await login();

  const socket = io(WS_URL, { path: '/dashboard-io', auth: { token }, transports: ['websocket'] });

  socket.on('connect', () => log(`connected to ${WS_URL}/dashboard-io (socket ${socket.id})`));
  socket.on('disconnect', (reason) => log(`disconnected: ${reason}`));
  socket.on('connect_error', async (err) => {
    // Most likely the access token expired; log in again and let socket.io retry.
    log(`connect_error: ${err.message} (re-logging in)`);
    try {
      socket.auth = { token: await login() };
    } catch (e) {
      log(e.message);
    }
    if (!socket.active) socket.connect();
  });

  socket.onAny((event, payload) => {
    if (HIDE_EVENTS.has(event)) return;
    log(BANNER[event] ?? `---------- ${event}`);
    console.log(JSON.stringify(payload, null, 2));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

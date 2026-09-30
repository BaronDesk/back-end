// Physical test driver: a linear script of REST calls against the running
// backend. It prints every request and every response. The real desktop agent
// does the enrollment and the PIN login; this script only drives the backend
// and reads back what it reports.
//
//   node tools/physical-test/driver.mjs
//
// Run observer.mjs in a second terminal at the same time.

import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';

// ---- config -----------------------------------------------------------------
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'hq-admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-me-immediately';
const GAMER_USERNAME = process.env.GAMER_USERNAME ?? 'gamer.wood';
const GAMER_PASSWORD = process.env.GAMER_PASSWORD ?? 'password123';
// A seeded station: its branch is where the enrollment token is minted. Default: first enrolled machine.
const STATION_ID = process.env.STATION_ID ?? '';
// Set to an already-enrolled real agent machine to skip the enrollment part.
const MACHINE_ID = process.env.MACHINE_ID ?? '';
const WALK_IN_MINUTES = Number(process.env.WALK_IN_MINUTES ?? 60);
// Optional: bring the gamer's wallet to this balance (millimes) first, so run-out comes quickly.
const START_BALANCE = process.env.START_BALANCE ? Number(process.env.START_BALANCE) : null;
const TOPUP_AMOUNT = Number(process.env.TOPUP_AMOUNT ?? 200);
const POLL_MS = Number(process.env.POLL_MS ?? 3000);

// ---- helpers ----------------------------------------------------------------
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(`[${ts()}]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function step(title) {
  console.log(`\n==================== ${title} ====================`);
}

async function pause(message) {
  await rl.question(`\n>>> ${message}\n>>> press Enter to continue `);
}

/** One REST call, printed in full. Throws on a non-2xx status. */
async function api(method, path, { token, body, quiet = false } = {}) {
  if (!quiet) log(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}`);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!quiet || !res.ok) log(`  <- ${res.status}`, JSON.stringify(data, null, 2));
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}`);
  return data;
}

async function login(username, password) {
  const { accessToken } = await api('POST', '/auth/login', { body: { username, password } });
  return accessToken;
}

/** Polls `read` until `done(value)` is true, printing the value only when it changes. */
async function waitFor(label, read, done, describe) {
  log(`waiting: ${label}`);
  let last = '';
  for (;;) {
    const value = await read();
    const line = describe(value);
    if (line !== last) {
      log(`  ${line}`);
      last = line;
    }
    if (done(value)) return value;
    await sleep(POLL_MS);
  }
}

function check(label, ok, detail) {
  log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  return ok;
}

// ---- flow -------------------------------------------------------------------
async function main() {
  log(`BASE_URL=${BASE_URL}`);

  step('1. admin login');
  let admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  // Access tokens are short-lived; the long waits below re-login before each call.
  const adminApi = async (method, path, opts = {}) => {
    try {
      return await api(method, path, { ...opts, token: admin });
    } catch (err) {
      if (!String(err.message).includes(' 401')) throw err;
      log('admin token expired, logging in again');
      admin = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
      return api(method, path, { ...opts, token: admin });
    }
  };

  let machineId = MACHINE_ID;
  if (!machineId) {
    step('2. mint enrollment token');
    const seeded = STATION_ID
      ? await adminApi('GET', `/machines/${STATION_ID}`)
      : (await adminApi('GET', '/machines?status=ENROLLED'))[0];
    if (!seeded) throw new Error('no seeded station found');
    log(`seeded station ${seeded.name ?? seeded.serialNumber} -> branch ${seeded.branchId}`);

    const mintedAt = Date.now();
    const { token } = await adminApi('POST', '/machines/enrollment-tokens', {
      body: { branchId: seeded.branchId, ttlMinutes: 60 },
    });
    console.log(`\n    ENROLLMENT TOKEN:  ${token}\n`);

    step('3. enrollment by the real agent');
    log('Give the token to the agent on the station PC and start it.');
    const pending = await waitFor(
      'agent to redeem the token (new PENDING machine in the branch)',
      async () => {
        const list = await adminApi('GET', `/machines?branchId=${seeded.branchId}&status=PENDING`, { quiet: true });
        return list.find((m) => new Date(m.createdAt).getTime() >= mintedAt - 5000) ?? null;
      },
      (m) => m !== null,
      (m) => (m ? `found ${m.serialNumber} (${m.id}) status ${m.enrollmentStatus}` : 'no new machine yet'),
    );
    machineId = pending.id;

    await pause(`Approve machine ${pending.serialNumber}?`);
    await adminApi('POST', `/machines/${machineId}/approve`);
  }

  const station = await waitFor(
    'station ENROLLED and ONLINE',
    () => adminApi('GET', `/api/v1/stations/${machineId}`, { quiet: true }),
    (s) => s.enrollmentStatus === 'ENROLLED' && s.status === 'ONLINE',
    (s) => `enrollment=${s.enrollmentStatus} status=${s.status} locked=${s.locked} lastSeen=${s.lastSeen}`,
  );
  log('station:', JSON.stringify(station, null, 2));

  step('4. gamer wallet and reservation');
  const gamer = await login(GAMER_USERNAME, GAMER_PASSWORD);
  let wallet = await api('GET', '/wallets/me', { token: gamer });
  const gamerProfileId = wallet.gamerProfileId;

  if (START_BALANCE !== null && wallet.balance !== START_BALANCE) {
    const diff = START_BALANCE - wallet.balance;
    await adminApi('POST', `/wallets/${gamerProfileId}/${diff > 0 ? 'credit' : 'debit'}`, {
      body: { amount: Math.abs(diff), type: 'ADJUSTMENT', idempotencyKey: `physical-test:${randomUUID()}` },
    });
    wallet = await adminApi('GET', `/wallets/${gamerProfileId}`);
  }
  const balanceBefore = wallet.balance;

  // Reservations are created by the gamer. A walk-in starts now, so the PIN is usable at once.
  const reservation = await api('POST', '/reservations/walk-in', {
    token: gamer,
    body: { machineId, durationMinutes: WALK_IN_MINUTES },
  });

  step('5. staff starts the session (PIN)');
  const started = await adminApi('POST', '/sessions', { body: { reservationId: reservation.id } });
  const sessionId = started.id;
  console.log(`\n    PIN:  ${started.pin}\n    (shown once, type it on the station lock screen)\n`);

  step('6. PIN login on the real agent');
  const readSession = () => adminApi('GET', `/sessions/${sessionId}`, { quiet: true });
  const readStation = () => adminApi('GET', `/api/v1/stations/${machineId}`, { quiet: true });
  const readBoth = async () => ({ session: await readSession(), station: await readStation() });
  const describeBoth = ({ session, station }) =>
    `session=${session.status} metered=${session.meteredSeconds}s | station locked=${station.locked} sessionId=${station.sessionId}`;

  const active = await waitFor(
    'session ACTIVE and station locked=false',
    readBoth,
    ({ session, station }) => session.status === 'ACTIVE' && station.locked === false,
    describeBoth,
  );
  log(`metering started, rate ${active.session.rateCentsPerMinute} millimes/min, wallet ${balanceBefore}`);
  log('observer should show station_status with locked=false for this station.');

  step('7. run-out warning and wallet top-up');
  await pause(`Wait for SESSION_RUNOUT_WARNING in the observer. Then top up ${TOPUP_AMOUNT} millimes?`);
  await adminApi('POST', `/wallets/${gamerProfileId}/credit`, {
    body: { amount: TOPUP_AMOUNT, type: 'CREDIT', idempotencyKey: `physical-test:${randomUUID()}` },
  });
  await adminApi('GET', `/wallets/${gamerProfileId}`);
  log('the backend reschedules the warn/lock timers from the new balance;');
  log('observer should show a new SESSION_RUNOUT_WARNING later than it would have been.');

  step('8. run-out auto-lock');
  await waitFor(
    'run-out lock: session PAUSED and station locked=true',
    readBoth,
    ({ session, station }) => session.status === 'PAUSED' && station.locked === true,
    describeBoth,
  );

  step('9. staff ends the session');
  await pause('End the session now?');
  await adminApi('POST', `/sessions/${sessionId}/end`, { body: { reason: 'physical test' } });
  const done = await waitFor(
    'session COMPLETED (settled)',
    readSession,
    (s) => s.status === 'COMPLETED',
    (s) => `session=${s.status} settledAt=${s.settledAt}`,
  );
  log('session:', JSON.stringify(done, null, 2));

  step('10. settlement');
  const entries = await adminApi('GET', `/wallets/${gamerProfileId}/entries?take=100`);
  const debits = entries.filter((e) => e.sessionId === sessionId);
  const total = done.billingBreakdown?.totalCents;
  const reservations = await api('GET', '/reservations', { token: gamer });
  const res = reservations.find((r) => r.id === reservation.id);

  console.log('');
  check('session COMPLETED', done.status === 'COMPLETED');
  check('billing amount persisted', typeof total === 'number', `billingBreakdown.totalCents=${total}`);
  check('no debit failure flagged', !done.billingBreakdown?.debitFailed);
  check('exactly one wallet debit for the session', debits.length === 1, `${debits.length} entries`);
  if (debits.length === 1) check('debit equals billed amount', debits[0].amount === -total, `amount=${debits[0].amount}`);
  check('reservation COMPLETED', res?.status === 'COMPLETED', `status=${res?.status}`);
}

main()
  .catch((err) => {
    console.error(`\n[${ts()}] ABORTED: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());

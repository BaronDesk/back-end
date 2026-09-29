/**
 * Physical test seed: provisions a demo venue for the multi-PC LAN test.
 * THROWAWAY TEST TOOLING (tools/physical-test/). Not app code. Delete with the folder.
 *
 * Run inside the backend container, from the repo root on the server PC:
 *
 *   npm run dc -- exec -e PT_STATIONS="PC-ALICE,PC-BOB" backend npx tsx tools/physical-test/seed.ts
 *
 * PT_STATIONS     comma-separated serial numbers, one per station PC (use each PC's
 *                 hostname: `hostname` in PowerShell). Required.
 * PT_SERVER_HOST  name the agents dial (default cstam-server.local, see RUNBOOK §2).
 *
 * Idempotent: run it again at any time (for example to add a station). Existing rows
 * are reused, station tokens are re-minted, balances are topped up only once.
 *
 * DEV SHORTCUT: machines are written ENROLLED directly and station JWTs are minted here
 * with JWT_ACCESS_SECRET, exactly as enrollment must (docs/ENROLLMENT_HANDOFF.md §3),
 * because the real enrollment flow is not built yet. Everything else goes through
 * the backend's own REST API so the real services run.
 *
 * Output (tools/physical-test/out/, git-ignored, contains secrets):
 *   seed-output.json         everything, including tokens and passwords
 *   observer-config.json     what the observer page needs (no tokens)
 *   agent-<serial>.ps1       the script each member runs on their PC
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import jwt from 'jsonwebtoken';

import { PrismaClient } from '../../src/generated/prisma/index.js';

const API = process.env.PT_API ?? 'http://127.0.0.1:3000';
const SERVER_HOST = process.env.PT_SERVER_HOST ?? 'cstam-server.local';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

const BRANCH_NAME = 'PT Venue';
const ADMIN = { username: 'pt-admin', password: 'pt-admin-2026!' };
const GAMER_PASSWORD = 'pt-gamer-2026!';
const TOPUP_CENTS = 10_000; // 100.00
const PAYG_CENTS_PER_HOUR = 6_000; // 100 cents per minute: one minute of play is easy to read
const MEMBERSHIP_PLAN = { name: 'PT Gold (50% off)', price: 5, durationDays: 30, discountPercent: 50, bookingAdvanceDays: 7 };
const SUBSCRIPTION_PLAN = {
  name: 'PT Night Owl',
  price: 10,
  durationDays: 30,
  benefits: { windows: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '18:00', endTime: '23:59', discountPercent: 20 }] },
};
// Classic Win32 tools present on every Windows 10/11 PC, so a launch is visible.
// calc.exe on Windows 11 is a stub that starts CalculatorApp and exits: processName
// lets the agent track (and close) the real process.
const GAMES = [
  { gameId: 'charmap', name: 'Character Map (test game)', launchType: 'exe', target: 'C:\\Windows\\System32\\charmap.exe', processName: 'charmap.exe' },
  { gameId: 'calc', name: 'Calculator (test game)', launchType: 'exe', target: 'C:\\Windows\\System32\\calc.exe', processName: 'CalculatorApp.exe' },
];
const STATION_TOKEN_TTL = '7d';
const RESERVATION_HOURS = 4;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

type Json = Record<string, any>;

async function api(method: string, path: string, body?: unknown, token?: string, okStatuses: number[] = []): Promise<Json> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  return { status: res.status, data };
}

async function login(username: string, password: string): Promise<string> {
  return (await api('POST', '/auth/login', { username, password })).data.accessToken;
}

function serialsFromEnv(): string[] {
  const serials = (process.env.PT_STATIONS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (serials.length === 0) {
    throw new Error('PT_STATIONS is empty. Example: -e PT_STATIONS="PC-ALICE,PC-BOB" (each PC\'s hostname)');
  }
  for (const s of serials) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) throw new Error(`invalid serial "${s}" (letters, digits, . _ - only)`);
  }
  return [...new Set(serials)];
}

async function ensureBranch() {
  return (
    (await prisma.branch.findFirst({ where: { name: BRANCH_NAME } })) ??
    (await prisma.branch.create({ data: { name: BRANCH_NAME, location: 'Physical test LAN' } }))
  );
}

async function ensureAdmin() {
  const passwordHash = await hash(ADMIN.password, { algorithm: 2 /* Argon2id */ });
  // hq ADMIN: no employee profile, so no branch, so the dashboard feed sees every branch.
  return prisma.user.upsert({
    where: { username: ADMIN.username },
    update: { passwordHash, role: 'ADMIN', accountStatus: 'ACTIVE' },
    create: { username: ADMIN.username, passwordHash, role: 'ADMIN', accountStatus: 'ACTIVE' },
  });
}

async function ensurePlan(kind: 'membership' | 'subscription', plan: Json, admin: string) {
  const list = (await api('GET', `/${kind}-plans`, undefined, admin)).data as Json[];
  const existing = list.find((p) => p.name === plan.name);
  if (existing) return existing;
  return (await api('POST', `/${kind}-plans`, plan, admin)).data;
}

async function ensureGames(admin: string) {
  const list = (await api('GET', '/api/v1/games', undefined, admin)).data as Json[];
  const games: Json[] = [];
  for (const def of GAMES) {
    const existing = list.find((g) => g.gameId === def.gameId);
    if (existing) {
      const patched = await api('PATCH', `/api/v1/games/${existing.id}`, { ...def, gameId: undefined, enabled: true }, admin);
      games.push(patched.data);
    } else {
      games.push((await api('POST', '/api/v1/games', { ...def, enabled: true }, admin)).data);
    }
  }
  return games;
}

async function ensureMachine(serialNumber: string, branchId: string) {
  // Direct write: stands in for enrollment (see header).
  return prisma.machine.upsert({
    where: { serialNumber },
    update: { branchId, enrollmentStatus: 'ENROLLED' },
    create: { serialNumber, branchId, agentPublicKey: '', enrollmentStatus: 'ENROLLED', name: serialNumber },
  });
}

function mintStationToken(machine: { id: string; serialNumber: string; branchId: string }): string {
  // Same claims, key and algorithm (HS256) as test/station-token.ts and the admission code.
  return jwt.sign(
    { sub: machine.id, type: 'station', serialNumber: machine.serialNumber, branchId: machine.branchId },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: STATION_TOKEN_TTL },
  );
}

/** Creates the gamer if needed, tops its wallet up once, returns its ids. */
async function ensureGamer(username: string, admin: string) {
  await api('POST', '/users', { username, password: GAMER_PASSWORD }, undefined, [409]);
  const token = await login(username, GAMER_PASSWORD);
  const { gamerProfileId } = (await api('GET', '/wallets/me', undefined, token)).data;
  await api('POST', `/wallets/${gamerProfileId}/credit`, { amount: TOPUP_CENTS, idempotencyKey: 'pt-seed-topup' }, admin);
  const { balance } = (await api('GET', `/wallets/${gamerProfileId}`, undefined, admin)).data;
  return { username, password: GAMER_PASSWORD, token, gamerProfileId, balance };
}

/** One CONFIRMED reservation with no session yet, starting now. */
async function ensureReservation(gamerProfileId: string, machineId: string) {
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + RESERVATION_HOURS * 3_600_000);
  const unused = await prisma.reservation.findFirst({
    where: { gamerProfileId, machineId, status: 'CONFIRMED', sessions: { none: {} } },
    orderBy: { createdAt: 'desc' },
  });
  if (unused) return prisma.reservation.update({ where: { id: unused.id }, data: { startTime, endTime } });
  return prisma.reservation.create({ data: { gamerProfileId, machineId, startTime, endTime, status: 'CONFIRMED' } });
}

function agentScript(serial: string, token: string): string {
  return `# BaronDesk agent for station ${serial} - physical test (generated ${new Date().toISOString()})
# Run from the agent repo root (the Desktop-Agent folder), in PowerShell.
# Run PowerShell "as Administrator" if you want CPU temperatures.
$env:DOTNET_ENVIRONMENT               = "Development"
$env:Agent__ServerUrl                 = "wss://${SERVER_HOST}/agent-ws"
$env:Agent__AllowUntrustedCertificate = "true"
$env:Agent__PinnedCertificateHash     = ""
$env:Agent__SerialNumber              = "${serial}"
$env:Agent__StationToken              = "${token}"
dotnet run --project src/BaronDeskAgent.ServiceCore
`;
}

async function main() {
  const serials = serialsFromEnv();
  if (!process.env.JWT_ACCESS_SECRET) throw new Error('JWT_ACCESS_SECRET is not set (run this inside the backend container)');

  const branch = await ensureBranch();
  await ensureAdmin();
  const admin = await login(ADMIN.username, ADMIN.password);

  await api('PUT', `/branches/${branch.id}/pricing`, { paygRate: PAYG_CENTS_PER_HOUR, bookingRate: PAYG_CENTS_PER_HOUR }, admin);
  const membershipPlan = await ensurePlan('membership', MEMBERSHIP_PLAN, admin);
  const subscriptionPlan = await ensurePlan('subscription', SUBSCRIPTION_PLAN, admin);
  const games = await ensureGames(admin);

  const stations = [];
  for (const [index, serial] of serials.entries()) {
    const machine = await ensureMachine(serial, branch.id);
    const token = mintStationToken(machine);
    for (const game of games) await api('PUT', `/api/v1/games/${game.id}/stations/${machine.id}`, {}, admin);

    const n = index + 1;
    const standard = await ensureGamer(`pt-gamer-${n}`, admin);
    const member = await ensureGamer(`pt-member-${n}`, admin);
    // Bought through the real purchase route (debits 5.00 once); the key makes re-runs a no-op.
    await api('POST', `/membership-plans/${membershipPlan.id}/purchase`, { idempotencyKey: 'pt-seed-membership' }, member.token, [409]);
    member.balance = (await api('GET', `/wallets/${member.gamerProfileId}`, undefined, admin)).data.balance;

    const standardReservation = await ensureReservation(standard.gamerProfileId, machine.id);
    const memberReservation = await ensureReservation(member.gamerProfileId, machine.id);

    const gamer = (g: typeof standard, reservationId: string) => ({
      username: g.username,
      password: g.password,
      gamerProfileId: g.gamerProfileId,
      balanceCents: g.balance,
      reservationId,
    });
    stations.push({
      serial,
      machineId: machine.id,
      token,
      games: games.map((g) => g.gameId),
      gamers: { standard: gamer(standard, standardReservation.id), member: gamer(member, memberReservation.id) },
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    serverHost: SERVER_HOST,
    branch: { id: branch.id, name: branch.name },
    admin: ADMIN,
    pricing: { paygCentsPerHour: PAYG_CENTS_PER_HOUR, standardCentsPerMinute: Math.round(PAYG_CENTS_PER_HOUR / 60) },
    membershipPlan: { id: membershipPlan.id, name: membershipPlan.name, discountPercent: MEMBERSHIP_PLAN.discountPercent },
    subscriptionPlan: { id: subscriptionPlan.id, name: subscriptionPlan.name },
    stations,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'seed-output.json'), JSON.stringify(output, null, 2));
  writeFileSync(
    join(OUT_DIR, 'observer-config.json'),
    JSON.stringify(
      {
        ...output,
        admin: { username: ADMIN.username },
        stations: stations.map(({ token: _token, gamers, ...s }) => ({
          ...s,
          gamers: Object.fromEntries(Object.entries(gamers).map(([k, { password: _p, ...g }]) => [k, g])),
        })),
      },
      null,
      2,
    ),
  );
  for (const s of stations) writeFileSync(join(OUT_DIR, `agent-${s.serial}.ps1`), agentScript(s.serial, s.token));

  console.log(`\nPT seed done. Branch "${branch.name}" (${branch.id})`);
  console.log(`Observer / dashboard login: ${ADMIN.username} / ${ADMIN.password}`);
  console.log(`Pricing: ${PAYG_CENTS_PER_HOUR} cents/hour = ${output.pricing.standardCentsPerMinute} cents/min; members ${MEMBERSHIP_PLAN.discountPercent}% off\n`);
  for (const s of stations) {
    console.log(`== Station ${s.serial}  (machine ${s.machineId})`);
    console.log(`   agent script : tools/physical-test/out/agent-${s.serial}.ps1`);
    console.log(`   token        : ${s.token.slice(0, 24)}... (${s.token.length} chars, valid ${STATION_TOKEN_TTL})`);
    for (const [kind, g] of Object.entries(s.gamers)) {
      console.log(`   ${kind.padEnd(9)}: ${g.username} / ${g.password}  wallet ${g.balanceCents} cents  reservation ${g.reservationId}`);
    }
  }
  console.log(`\nFull output (secrets): tools/physical-test/out/seed-output.json`);
}

main()
  .catch((err) => {
    console.error(`PT seed failed: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

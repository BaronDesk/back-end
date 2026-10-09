/**
* SEED DATA SUMMARY
* -----------------
* Money: every money column is whole coins (1000 coins = 1 DT): wallets, ledger, plan prices, rates per hour.
*
* Pricing:             one price list for every branch: 4000 coins/h (1 DT per 15 min) walk-in and booked
* Branches (2):        CENTRE El Manar, CENTRE Lac 2 — each w/ 5 machines + full game catalog
* Games (6):            cs2, valorant, dota2, lol, fortnite, fc25
* Membership plans (3): Standard (free/0%), Pro (15000 coins/mo, 10%), Elite (30000 coins/mo, 20%)
* Subscription plans:   The Night Owl (25000 coins/mo), The Weekend Warrior (40000 coins/mo)
* Ranks (7):           Wood 0 XP, Bronze 500, Silver 1500, Gold 4000, Diamond 8000, Master 15000, GrandMaster 25000
* Badges:              tiers, passes and ranks get the Graphic-Charter badge (prisma/seed-assets/badges)
*                      written to UPLOAD_DIR, unless they already have one (an admin's choice is kept)
*
* Staff:  2 managers, 4 employees (1 per branch pair) — login: password123
* Gamers: 10 total, one per XP tier (Wood → Grandmaster) — login: password123
*   - gamer.silver     -> Pro membership
*   - gamer.gold       -> Elite membership + Night Owl sub
*   - gamer.diamond    -> Pro membership + Weekend Warrior sub
*   - gamer.master     -> Elite membership
*   - gamer.grandmaster-> Elite membership + both subs
*   - gamer.midswitch  -> old Pro (CANCELLED) -> new Elite (ACTIVE), switched mid-session
*   - gamer.wood/iron/regular -> no plan, wallet top-up only
*   - gamer.newbie     -> 0 XP, 0 balance, no plan (blank-slate case)
*
* Reservations/sessions (7 total, covers every status + billing edge cases):
*   COMPLETED (gold, Elite discount) | ACTIVE (diamond, metering now) | PAUSED (iron, locked mid-session)
*   PENDING (newbie, booked tomorrow) | CANCELLED (master)
*   COMPLETED (gamer.midswitch: upgraded Pro->Elite mid-session; rate stays pinned to old Pro snapshot)
*   COMPLETED (gold: session runs past Night Owl's 06:00 cutoff; billingBreakdown splits free/paid minutes)
*
* Every wallet balance is reconciled to its ledger history (top-up -> plan debits -> session debit(s)).
* Script is safe to re-run (upsert / find-or-create throughout).
*/



import 'dotenv/config';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { hash } from '@node-rs/argon2';

import { PrismaClient, type TransactionType } from '../src/generated/prisma/index.js';
import { fileOf, writeImage } from '../src/modules/uploads/util/image-files.js';

// @node-rs/argon2's Algorithm is an ambient `const enum`, which isolatedModules
// forbids referencing directly. 2 is Algorithm.Argon2id (also the library default).
const ARGON2ID = 2;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/*
 Every money column (Wallet.balance, LedgerEntry.amount, plan prices, Pricing
 and Session rates per hour) is whole coins. The seed thinks in dinars, the
 Tunisian price sheet: dt(4) is the coins worth 4 DT.
 */
const COINS_PER_DT = 1000;
const dt = (amount: number) => Math.round(amount * COINS_PER_DT);

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID });
}

// Same folder as the backend (UploadsModule): /app/uploads in Docker, the `uploads` volume.
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR ?? 'uploads');
const BADGES = path.join(import.meta.dirname, 'seed-assets', 'badges');

/**
 * Gives a row its Graphic-Charter badge, unless it has a badge whose file is
 * there (set by an earlier run, or by an admin since). Returns whether it wrote one.
 */
async function seedBadge(folder: string, name: string, current: string | null, save: (badgeUrl: string) => Promise<unknown>) {
  const file = current ? fileOf(UPLOAD_DIR, current) : null;
  if (current && (!file || (await access(file).then(() => true, () => false)))) return false;
  await save(await writeImage(UPLOAD_DIR, await readFile(path.join(BADGES, folder, `${name}.webp`)), 'image'));
  return true;
}

interface LedgerPlan {
  amount: number; // signed + credit, - debit
  type: TransactionType;
  sessionId?: string;
}

/** Posts a deterministic ledger history for a wallet and syncs Wallet.balance to the running total. */
async function postLedgerHistory(walletId: string, plan: LedgerPlan[]): Promise<void> {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  let balance = wallet.balance;
  for (const entry of plan) {
    balance += entry.amount;
    await prisma.ledgerEntry.create({
      data: {
        walletId,
        amount: entry.amount,
        balanceAfter: balance,
        type: entry.type,
        sessionId: entry.sessionId,
      },
    });
  }
  await prisma.wallet.update({ where: { id: walletId }, data: { balance } });
}

async function main() {
  // --- HQ admin ---
  const adminUsername = process.env.SEED_ADMIN_USERNAME ?? 'hq-admin';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-immediately';
  const admin = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      passwordHash: await hashPassword(adminPassword),
                                         role: 'ADMIN',
                                         accountStatus: 'ACTIVE',
    },
  });
  console.log(`seeded hq ADMIN: ${admin.username} (${admin.id})`);

  const devPasswordHash = await hashPassword('password123');

  // --- Branches ---
  const branchSeeds = [
    { name: 'CENTRE El Manar', location: 'Tunis, El Manar 2' },
    { name: 'CENTRE Lac 2', location: 'Tunis, Les Berges du Lac 2' },
  ];
  const branches = [];
  for (const seed of branchSeeds) {
    let branch = await prisma.branch.findFirst({ where: { name: seed.name } });
    if (!branch) branch = await prisma.branch.create({ data: { name: seed.name, location: seed.location } });
    branches.push(branch);
  }
  const [elManar, lac2] = branches;
  console.log(`seeded ${branches.length} branch(es)`);

  // --- Pricing: one price list for every branch, coins per hour (kept if already set) ---
  await prisma.pricing.upsert({ where: { id: 1 }, update: {}, create: { id: 1, paygRate: dt(4), bookingRate: dt(4) } });
  console.log('seeded pricing');

  // --- Membership plans ---
  const membershipPlanSeeds = [
    { name: 'Standard', price: dt(0), durationDays: 36500, discountPercent: 0, bookingAdvanceDays: 0 },
    { name: 'Pro', price: dt(15), durationDays: 30, discountPercent: 10, bookingAdvanceDays: 2 },
    { name: 'Elite', price: dt(30), durationDays: 30, discountPercent: 20, bookingAdvanceDays: 7 },
  ];
  const membershipPlans: Record<string, Awaited<ReturnType<typeof prisma.membershipPlan.upsert>>> = {};
  for (const seed of membershipPlanSeeds) {
    membershipPlans[seed.name] = await prisma.membershipPlan.upsert({
      where: { name: seed.name },
      update: {},
      create: seed,
    });
  }
  console.log(`seeded ${Object.keys(membershipPlans).length} membership plan(s)`);

  // --- Subscription plans ---
  const subscriptionPlanSeeds = [
    {
      name: 'The Night Owl',
      price: dt(25),
      durationDays: 30,
      // free play every night, 00:00-06:00 local time
      benefits: { windows: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '00:00', endTime: '06:00', discountPercent: 100 }] },
    },
    {
      name: 'The Weekend Warrior',
      price: dt(40),
      durationDays: 30,
      // half price all day Saturday and Sunday (the API's benefits are time windows, no hour quotas)
      benefits: { windows: [{ daysOfWeek: [0, 6], startTime: '00:00', endTime: '00:00', discountPercent: 50 }] },
    },
  ];
  const subscriptionPlans: Record<string, Awaited<ReturnType<typeof prisma.subscriptionPlan.upsert>>> = {};
  for (const seed of subscriptionPlanSeeds) {
    subscriptionPlans[seed.name] = await prisma.subscriptionPlan.upsert({
      where: { name: seed.name },
      update: { benefits: seed.benefits },
      create: seed,
    });
  }
  console.log(`seeded ${Object.keys(subscriptionPlans).length} subscription plan(s)`);

  // --- Ranks (XP tiers) ---
  const rankSeeds = [
    { name: 'Wood', minXp: 0 },
    { name: 'Bronze', minXp: 500 },
    { name: 'Silver', minXp: 1500 },
    { name: 'Gold', minXp: 4000 },
    { name: 'Diamond', minXp: 8000 },
    { name: 'Master', minXp: 15000 },
    { name: 'GrandMaster', minXp: 25000 },
  ];
  const ranks = [];
  for (const seed of rankSeeds) {
    ranks.push(await prisma.rank.upsert({ where: { name: seed.name }, update: {}, create: seed }));
  }
  console.log(`seeded ${ranks.length} rank(s)`);

  // --- Badges (files in UPLOAD_DIR, links in the rows) ---
  let badges = 0;
  for (const plan of Object.values(membershipPlans)) {
    const current = (await prisma.membershipPlan.findUniqueOrThrow({ where: { id: plan.id } })).badgeUrl;
    if (await seedBadge('membership-plans', plan.name, current, (badgeUrl) => prisma.membershipPlan.update({ where: { id: plan.id }, data: { badgeUrl } }))) badges++;
  }
  for (const plan of Object.values(subscriptionPlans)) {
    const current = (await prisma.subscriptionPlan.findUniqueOrThrow({ where: { id: plan.id } })).badgeUrl;
    if (await seedBadge('subscription-plans', plan.name.replaceAll(' ', '-'), current, (badgeUrl) => prisma.subscriptionPlan.update({ where: { id: plan.id }, data: { badgeUrl } }))) badges++;
  }
  for (const rank of ranks) {
    if (await seedBadge('ranks', rank.name, rank.badgeUrl, (badgeUrl) => prisma.rank.update({ where: { id: rank.id }, data: { badgeUrl } }))) badges++;
  }
  console.log(`seeded ${badges} badge(s) into ${UPLOAD_DIR}`);

  // --- Games catalog ---
  const gameSeeds = [
    {
      gameId: 'notepad', // game of the year
      name: 'Notepad',
      launchType: 'exe' as const,
      target: 'C:\\Windows\\System32\\notepad.exe',
      processName: 'notepad.exe',
    },
    { gameId: 'cs2', name: 'Counter-Strike 2', launchType: 'steam' as const, target: '730', processName: 'cs2.exe' },
    {
      gameId: 'valorant',
      name: 'Valorant',
      launchType: 'exe' as const,
      target: 'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe',
      processName: 'VALORANT-Win64-Shipping.exe',
    },
    { gameId: 'dota2', name: 'Dota 2', launchType: 'steam' as const, target: '570', processName: 'dota2.exe' },
    {
      gameId: 'lol',
      name: 'League of Legends',
      launchType: 'exe' as const,
      target: 'C:\\Riot Games\\League of Legends\\LeagueClient.exe',
      processName: 'League of Legends.exe',
    },
    { gameId: 'fortnite', name: 'Fortnite', launchType: 'epic' as const, target: 'Fortnite', processName: 'FortniteClient-Win64-Shipping.exe' },
    { gameId: 'fc25', name: 'EA Sports FC 25', launchType: 'steam' as const, target: '2195250', processName: 'FC25.exe' },
  ];
  const games: Record<string, Awaited<ReturnType<typeof prisma.game.upsert>>> = {};
  for (const [i, seed] of gameSeeds.entries()) {
    games[seed.gameId] = await prisma.game.upsert({
      where: { gameId: seed.gameId },
      update: {},
      create: { ...seed, sortOrder: i },
    });
  }
  for (const branch of branches) {
    for (const game of Object.values(games)) {
      await prisma.gameBranch.upsert({
        where: { gameId_branchId: { gameId: game.id, branchId: branch.id } },
        update: {},
        create: { gameId: game.id, branchId: branch.id },
      });
    }
  }
  console.log(`seeded ${Object.keys(games).length} game(s), assigned to every branch`);

  // --- Machines ---
  const machinesByBranch: Record<string, Awaited<ReturnType<typeof prisma.machine.upsert>>[]> = {};
  for (const [branch, prefix] of [
    [elManar, 'MNR'],
    [lac2, 'LAC'],
  ] as const) {
    const list = [];
    for (let i = 1; i <= 5; i++) {
      const serialNumber = `${prefix}-PC-${String(i).padStart(2, '0')}`;
      const machine = await prisma.machine.upsert({
        where: { serialNumber },
        update: {},
        create: {
          serialNumber,
          branchId: branch.id,
          agentPublicKey: `seed-agent-public-key-${serialNumber}`,
          enrollmentStatus: 'ENROLLED',
          name: `PC-${String(i).padStart(2, '0')}`,
                                                  status: i % 4 === 0 ? 'OFFLINE' : 'ONLINE',
        },
      });
      list.push(machine);
    }
    machinesByBranch[branch.id] = list;
  }
  console.log('seeded 5 machine(s) per branch');

  // --- Staff: managers + employees --------------------------------------------
  const staffSeeds = [
    { username: 'manager.manar', role: 'MANAGER' as const, branch: elManar },
    { username: 'manager.lac2', role: 'MANAGER' as const, branch: lac2 },
    { username: 'employee.manar1', role: 'EMPLOYEE' as const, branch: elManar },
    { username: 'employee.manar2', role: 'EMPLOYEE' as const, branch: elManar },
    { username: 'employee.lac2.1', role: 'EMPLOYEE' as const, branch: lac2 },
    { username: 'employee.lac2.2', role: 'EMPLOYEE' as const, branch: lac2 },
  ];
  for (const seed of staffSeeds) {
    await prisma.user.upsert({
      where: { username: seed.username },
      update: {},
      create: {
        username: seed.username,
        passwordHash: devPasswordHash,
        role: seed.role,
        employeeProfile: { create: { managedBranchId: seed.branch.id, hireDate: new Date('2025-01-15') } },
      },
    });
  }
  console.log(`seeded ${staffSeeds.length} staff user(s) (password: "password123")`);

  // --- Gamers: one per XP tier ---
  // Levels: 25XP/15min — Wood 0-499, Iron 500-1499, Silver 1500-3999, Gold
  // 4000-7999, Diamond 8000-14999, Master 15000-24999, Grandmaster 25000+.
  const gamerSeeds = [
    { username: 'gamer.newbie', xp: 0, level: 1 },
    { username: 'gamer.regular', xp: 300, level: 1 },
    { username: 'gamer.wood', xp: 120, level: 1 },
    { username: 'gamer.iron', xp: 800, level: 2 },
    { username: 'gamer.silver', xp: 2200, level: 3 },
    { username: 'gamer.gold', xp: 5600, level: 4 },
    { username: 'gamer.diamond', xp: 11000, level: 5 },
    { username: 'gamer.master', xp: 18000, level: 6 },
    { username: 'gamer.grandmaster', xp: 31000, level: 7 },
    { username: 'gamer.midswitch', xp: 4200, level: 4 }, // upgrades Pro -> Elite mid-session
  ];
  const gamers: Record<string, { userId: string; gamerProfileId: string; walletId: string }> = {};
  for (const seed of gamerSeeds) {
    const user = await prisma.user.upsert({
      where: { username: seed.username },
      update: {},
      create: {
        username: seed.username,
        passwordHash: devPasswordHash,
        role: 'GAMER',
        gamerProfile: { create: { xp: seed.xp, level: seed.level, wallet: { create: {} } } },
      },
      include: { gamerProfile: { include: { wallet: true } } },
    });
    // On a rerun the nested creates above are skipped (upsert hit `update: {}`),
    // so fetch the profile/wallet that already exist instead of assuming they're on `user`.
    const gamerProfile =
    user.gamerProfile ?? (await prisma.gamerProfile.findUniqueOrThrow({ where: { userId: user.id } }));
    const wallet =
    (user.gamerProfile as any)?.wallet ??
    (await prisma.wallet.upsert({
      where: { gamerProfileId: gamerProfile.id },
      update: {},
      create: { gamerProfileId: gamerProfile.id },
    }));
    gamers[seed.username] = { userId: user.id, gamerProfileId: gamerProfile.id, walletId: wallet.id };
  }
  console.log(`seeded ${gamerSeeds.length} gamer(s) across every XP tier (password: "password123")`);

  // --- Memberships (at most one ACTIVE per gamer) ---
  async function grantMembership(username: string, planName: keyof typeof membershipPlans) {
    const gamer = gamers[username];
    const existing = await prisma.membership.findFirst({
      where: { gamerProfileId: gamer.gamerProfileId, status: 'ACTIVE' },
    });
    if (existing) return existing;
    const plan = membershipPlans[planName];
    const startDate = new Date();
    return prisma.membership.create({
      data: {
        gamerProfileId: gamer.gamerProfileId,
        membershipPlanId: plan.id,
        discountPercentSnapshot: plan.discountPercent,
        startDate,
        endDate: addDays(startDate, plan.durationDays),
                                    status: 'ACTIVE',
      },
    });
  }
  const now = new Date();
  const silverMembership = await grantMembership('gamer.silver', 'Pro');
  const goldMembership = await grantMembership('gamer.gold', 'Elite');
  const diamondMembership = await grantMembership('gamer.diamond', 'Pro');
  const masterMembership = await grantMembership('gamer.master', 'Elite');
  const grandmasterMembership = await grantMembership('gamer.grandmaster', 'Elite');

  // Edge case: gamer upgraded Pro -> Elite while a session was already running.
  // The old membership is superseded (CANCELLED) before the new one goes ACTIVE,
  // satisfying the one-ACTIVE-per-gamer constraint.
  const midswitchGamer = gamers['gamer.midswitch'];
  let oldProMembership = await prisma.membership.findFirst({
    where: { gamerProfileId: midswitchGamer.gamerProfileId, status: 'CANCELLED' },
  });
  if (!oldProMembership) {
    const oldStart = addDays(now, -1);
    oldProMembership = await prisma.membership.create({
      data: {
        gamerProfileId: midswitchGamer.gamerProfileId,
        membershipPlanId: membershipPlans['Pro'].id,
        discountPercentSnapshot: membershipPlans['Pro'].discountPercent,
        startDate: oldStart,
        endDate: addDays(oldStart, 30),
                                                      status: 'CANCELLED',
      },
    });
  }
  const midswitchMembership = await grantMembership('gamer.midswitch', 'Elite');
  console.log('seeded active memberships for silver/gold/diamond/master/grandmaster/midswitch gamers');

  // --- Subscriptions ---
  async function grantSubscription(username: string, planName: keyof typeof subscriptionPlans) {
    const gamer = gamers[username];
    const plan = subscriptionPlans[planName];
    const existing = await prisma.subscription.findFirst({
      where: { gamerProfileId: gamer.gamerProfileId, subscriptionPlanId: plan.id, status: 'ACTIVE' },
    });
    if (existing) return existing;
    const startDate = new Date();
    return prisma.subscription.create({
      data: {
        gamerProfileId: gamer.gamerProfileId,
        subscriptionPlanId: plan.id,
        benefitsSnapshot: plan.benefits as object,
        startDate,
        endDate: addDays(startDate, plan.durationDays),
                                      status: 'ACTIVE',
      },
    });
  }
  await grantSubscription('gamer.gold', 'The Night Owl');
  await grantSubscription('gamer.diamond', 'The Weekend Warrior');
  await grantSubscription('gamer.grandmaster', 'The Night Owl');
  await grantSubscription('gamer.grandmaster', 'The Weekend Warrior');
  console.log('seeded active subscriptions for gold/diamond/grandmaster gamers');

  // --- Reservations & sessions ---
  const mnrMachines = machinesByBranch[elManar.id];
  const lacMachines = machinesByBranch[lac2.id];

  // 1) COMPLETED: gamer.gold, 1h at El Manar, Elite 20% discount applied.
  {
    const start = addDays(now, -1);
    start.setHours(14, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    const reservation = await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.gold'].gamerProfileId,
        machineId: mnrMachines[0].id,
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
      },
    });
    const rateCoinsPerHour = Math.round(dt(4) * (1 - 20 / 100)); // Elite: 20% off the 4dt/h base rate
    const meteredSeconds = 3600;
    const totalCoins = Math.round((meteredSeconds / 3600) * rateCoinsPerHour);
    const session = await prisma.session.create({
      data: {
        reservationId: reservation.id,
        appliedMembershipId: goldMembership.id,
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
        meteredSeconds,
        rateCoinsPerHour,
        settledAt: end,
        billingBreakdown: { rateCoinsPerHour, meteredSeconds, totalCoins, appliedMembershipId: goldMembership.id },
      },
    });

    await postLedgerHistory(gamers['gamer.gold'].walletId, [
      { amount: dt(100), type: 'CREDIT' },
                            { amount: -dt(30), type: 'PAYMENT' }, // Elite membership purchase
                            { amount: -dt(25), type: 'PAYMENT' }, // The Night Owl subscription purchase
                            { amount: -totalCoins, type: 'PAYMENT', sessionId: session.id }, // this session's settlement
    ]);
  }

  // 2) ACTIVE: gamer.diamond, in progress right now at Lac 2, Pro 10% discount.
  {
    const start = new Date(now.getTime() - 20 * 60_000);
    const end = new Date(now.getTime() + 40 * 60_000);
    const reservation = await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.diamond'].gamerProfileId,
        machineId: lacMachines[0].id,
        startTime: start,
        endTime: end,
        status: 'ACTIVE',
      },
    });
    const rateCoinsPerHour = Math.round(dt(4) * (1 - 10 / 100)); // Pro: 10% off the 4dt/h base rate
    await prisma.session.create({
      data: {
        reservationId: reservation.id,
        appliedMembershipId: diamondMembership.id,
        startTime: start,
        endTime: end,
        status: 'ACTIVE',
        meteringStartedAt: start,
        rateCoinsPerHour,
      },
    });

    await postLedgerHistory(gamers['gamer.diamond'].walletId, [
      { amount: dt(80), type: 'CREDIT' },
                            { amount: -dt(15), type: 'PAYMENT' }, // Pro membership purchase
                            { amount: -dt(40), type: 'PAYMENT' }, // The Weekend Warrior subscription purchase
    ]);
  }

  // 3) PENDING: gamer.newbie, booked for tomorrow, session not started.
  {
    const start = addDays(now, 1);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.newbie'].gamerProfileId,
        machineId: mnrMachines[1].id,
        startTime: start,
        endTime: end,
        status: 'PENDING',
      },
    });
  }

  // 4) CANCELLED: gamer.master, booked then called off.
  {
    const start = addDays(now, -3);
    start.setHours(18, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.master'].gamerProfileId,
        machineId: lacMachines[1].id,
        startTime: start,
        endTime: end,
        status: 'CANCELLED',
      },
    });
    await postLedgerHistory(gamers['gamer.master'].walletId, [
      { amount: dt(100), type: 'CREDIT' },
                            { amount: -dt(30), type: 'PAYMENT' }, // Elite membership purchase
    ]);
  }
  // 5) PAUSED: gamer.iron, station locked mid-session (e.g. funds ran low), unsettled.
  {
    const start = new Date(now.getTime() - 40 * 60_000);
    const end = new Date(now.getTime() + 20 * 60_000);
    const reservation = await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.iron'].gamerProfileId,
        machineId: mnrMachines[2].id,
        startTime: start,
        endTime: end,
        status: 'ACTIVE',
      },
    });
    const rateCoinsPerHour = dt(4); // no membership: full base rate
    await prisma.session.create({
      data: {
        reservationId: reservation.id,
        startTime: start,
        endTime: end,
        status: 'PAUSED',
        meteredSeconds: 25 * 60, // 25 min accrued before it got locked
        rateCoinsPerHour,
        lockedAt: new Date(now.getTime() - 15 * 60_000),
      },
    });
  }

  // 6) Membership switched mid-session: gamer.midswitch was Pro when the session
  // started, upgraded to Elite while ACTIVE. appliedMembershipId + the billing
  // breakdown stay pinned to the OLD (now-cancelled) Pro discount for this session.
  {
    const start = addDays(now, -1);
    start.setHours(20, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    const reservation = await prisma.reservation.create({
      data: {
        gamerProfileId: midswitchGamer.gamerProfileId,
        machineId: mnrMachines[3].id,
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
      },
    });
    const rateCoinsPerHour = Math.round(dt(4) * (1 - 10 / 100)); // Pro (old plan): 10% off
    const meteredSeconds = 3600;
    const totalCoins = Math.round((meteredSeconds / 3600) * rateCoinsPerHour);
    const session = await prisma.session.create({
      data: {
        reservationId: reservation.id,
        appliedMembershipId: oldProMembership.id, // snapshot: old plan, not the new Elite one
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
        meteredSeconds,
        rateCoinsPerHour,
        settledAt: end,
        billingBreakdown: {
          rateCoinsPerHour,
          meteredSeconds,
          totalCoins,
          appliedMembershipId: oldProMembership.id,
          note: 'membership upgraded to Elite after this session started; rate stayed pinned to Pro',
        },
      },
    });
    await postLedgerHistory(midswitchGamer.walletId, [
      { amount: dt(50), type: 'CREDIT' },
                            { amount: -dt(15), type: 'PAYMENT' }, // original Pro membership purchase
                            { amount: -dt(30), type: 'PAYMENT' }, // later Elite upgrade purchase
                            { amount: -totalCoins, type: 'PAYMENT', sessionId: session.id },
    ]);
  }

  // 7) Night Owl overrun: gamer.gold's session (05:30-06:30) crosses the free
  // window's 06:00 cutoff. Fixture data: the backend prices a session once, at
  // check-in, so this billingBreakdown's free/paid split is illustrative.
  {
    const start = addDays(now, -2);
    start.setHours(5, 30, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000); // ends 06:30, 30 min past the window
    const reservation = await prisma.reservation.create({
      data: {
        gamerProfileId: gamers['gamer.gold'].gamerProfileId,
        machineId: mnrMachines[4].id,
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
      },
    });
    const rateCoinsPerHour = Math.round(dt(4) * (1 - 20 / 100)); // Elite: 20% off, applied to the paid portion only
    const freeMinutes = 30; // 05:30-06:00, covered by The Night Owl
    const paidMinutes = 30; // 06:00-06:30, outside the free window
    const totalCoins = Math.round((paidMinutes / 60) * rateCoinsPerHour);
    const session = await prisma.session.create({
      data: {
        reservationId: reservation.id,
        appliedMembershipId: goldMembership.id,
        startTime: start,
        endTime: end,
        status: 'COMPLETED',
        meteredSeconds: (freeMinutes + paidMinutes) * 60,
                                                rateCoinsPerHour,
                                                settledAt: end,
                                                billingBreakdown: {
                                                  rateCoinsPerHour,
                                                  freeMinutes,
                                                  paidMinutes,
                                                  totalCoins,
                                                  nightOwlWindow: { start: '00:00', end: '06:00' },
                                                  note: 'session ran past the Night Owl free window; only paidMinutes were billed',
                                                },
      },
    });
    await postLedgerHistory(gamers['gamer.gold'].walletId, [
      { amount: -totalCoins, type: 'PAYMENT', sessionId: session.id },
    ]);
  }

  console.log('seeded 7 reservation(s)/session(s): COMPLETED x3, ACTIVE, PAUSED, PENDING, CANCELLED');

  // --- Remaining gamers: simple top-up wallets, no plans ----------------------
  await postLedgerHistory(gamers['gamer.wood'].walletId, [{ amount: dt(2), type: 'CREDIT' }]);
  await postLedgerHistory(gamers['gamer.iron'].walletId, [{ amount: dt(5), type: 'CREDIT' }]);
  await postLedgerHistory(gamers['gamer.silver'].walletId, [
    { amount: dt(30), type: 'CREDIT' },
                          { amount: -dt(15), type: 'PAYMENT' }, // Pro membership purchase
  ]);
  await postLedgerHistory(gamers['gamer.grandmaster'].walletId, [
    { amount: dt(200), type: 'CREDIT' },
                          { amount: -dt(30), type: 'PAYMENT' }, // Elite membership purchase
                          { amount: -dt(25), type: 'PAYMENT' }, // The Night Owl subscription purchase
                          { amount: -dt(40), type: 'PAYMENT' }, // The Weekend Warrior subscription purchase
  ]);
  await postLedgerHistory(gamers['gamer.regular'].walletId, [{ amount: dt(1), type: 'CREDIT' }]);
  // gamer.newbie is left at the default 0 balance

  console.log('done.');
}

main()
.catch((err) => {
  console.error(err);
  process.exitCode = 1;
})
.finally(() => prisma.$disconnect());

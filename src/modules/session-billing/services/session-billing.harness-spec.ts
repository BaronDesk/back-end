// Shared setup for the session-billing service specs. Named *-spec.ts so the
// build leaves it out (tsconfig.build.json excludes **/*spec.ts), while vitest
// does not run it (it only picks up *.spec.ts).
import { Subject } from 'rxjs';
import { vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { StationSessionPort } from '../../ops/services/station-session.port.js';
import { SessionExtensionsService } from './session-extensions.service.js';
import { SessionLoginService } from './session-login.service.js';
import { SessionMeteringService } from './session-metering.service.js';
import { SessionNoticesService } from './session-notices.service.js';
import { SessionQueriesService } from './session-queries.service.js';
import { SessionRunoutService } from './session-runout.service.js';
import { SessionSweepService } from './session-sweep.service.js';
import { SessionsService } from './sessions.service.js';
import { StationEventsProcessor } from './station-events.processor.js';
import { StationLinkService } from './station-link.service.js';

export function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'user-1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j1', ...overrides };
}

export const STATION = { machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' };
export const HOUR = 60 * 60_000;
/** The lease granted: min(SESSION_LEASE_CAP_S, STATION_LEASE_S), what the station itself holds to. */
export const LEASE_CAP_S = 60;
const SESSION_LEASE_CAP_S = 180;
export const MAX_ATTEMPTS = 3;

/** A reservation window that is open right now: started 10 minutes ago, ends in 50. */
export function window() {
  const now = Date.now();
  return { startTime: new Date(now - 10 * 60_000), endTime: new Date(now + 50 * 60_000) };
}

export function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1', gamerProfileId: 'g1', machineId: 'm1', status: 'CONFIRMED', isWalkIn: true, ...window(),
    machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' },
    ...overrides,
  };
}

export function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', reservationId: 'res-1', appliedMembershipId: null, status: 'PENDING',
    rateCoinsPerHour: 6000, meteredSeconds: 0, meteringStartedAt: null, lockedAt: null,
    settledAt: null, billingBreakdown: null, createdAt: new Date(),
    pinHash: null, pinExpiresAt: null, pinUsedAt: null, pinAttempts: 0,
    accruedCoins: 0, nextRateCoinsPerHour: null, rateSwitchAt: null, endingNoticeSentAt: null, lockReason: null,
    ...window(),
    reservation: { gamerProfileId: 'g1', machineId: 'm1', isWalkIn: true, machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' } },
    ...overrides,
  };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Every session-billing service wired together as Nest would, over mocked
 * collaborators, with onModuleInit run: a spec drives one service and sees
 * the effects of the others (settlement, run-out, notices).
 */
export function createHarness() {
  const repo: Record<string, ReturnType<typeof vi.fn>> = {
    findReservationForStart: vi.fn(async () => reservation()),
    findActiveForReservation: vi.fn(async () => null),
    findOpenForReservation: vi.fn(async () => null),
    withMachineLock: vi.fn(async (_machineId: string, fn: (tx: unknown) => unknown) => fn({})),
    findUnusedPinsForGamer: vi.fn(async () => []),
    closeAsNoShow: vi.fn(async () => true),
    findExpiredUnusedPins: vi.fn(async () => []),
    expireAsNoShow: vi.fn(async () => true),
    create: vi.fn(async (data) => sessionRow(data)),
    cancelPending: vi.fn(async () => ({ count: 1 })),
    findById: vi.fn(async () => sessionRow({ status: 'PENDING', pinUsedAt: new Date() })),
    findForSettlement: vi.fn(async () => sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date(Date.now() - 5 * 60_000) })),
    findByIdWithReservation: vi.fn(async () => sessionRow()),
    findLoginCandidate: vi.fn(async () => null),
    claimPinAttempt: vi.fn(async () => true),
    spendPin: vi.fn(async () => true),
    update: vi.fn(async (id, data) => sessionRow({ id, ...data })),
    findPausedByGamer: vi.fn(async () => null),
    findActiveByGamer: vi.fn(async () => null),
    activate: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    findOverdueOpen: vi.fn(async () => []),
    markNoShows: vi.fn(async () => 0),
    findGrantedByGamer: vi.fn(async () => []),
    findGrantedOnMachine: vi.fn(async () => []),
    findUpcomingUnstarted: vi.fn(async () => []),
    userIdForGamer: vi.fn(async () => 'user-g1'),
    findDueRateSwitches: vi.fn(async () => []),
    findEndingSoon: vi.fn(async () => []),
    extendIfFree: vi.fn(async (input) => ({ kind: 'extended', session: sessionRow({ ...input.session, endTime: input.to }) })),
    isMachineBusy: vi.fn(async () => false),
    billOfflineOnce: vi.fn(async () => true),
  };
  const presence: Record<string, any> = {
    statusChanges: new Subject(),
    sessionEnded: new Subject(),
    // Only the offline handling reads it: a station whose OFFLINE event is handled is still offline.
    isOnline: vi.fn(() => false),
    agentStateOf: vi.fn(() => null),
    resolve: vi.fn(() => STATION),
    sessionOf: vi.fn(() => 's1'),
    lastSeenBeforeConnect: vi.fn(() => null),
    lastContactOf: vi.fn(() => null),
    outageOf: vi.fn(() => null),
  };
  const agents: { sendControl: ReturnType<typeof vi.fn> } = { sendControl: vi.fn(() => true) };
  const dashboard: { publishToBranch: ReturnType<typeof vi.fn>; publishToUser: ReturnType<typeof vi.fn> } = { publishToBranch: vi.fn(), publishToUser: vi.fn() };
  const pricing: { getRates: ReturnType<typeof vi.fn> } = { getRates: vi.fn(async () => ({ paygRate: 6000, bookingRate: 9000 })) }; // coins per hour: 100/min walk-in, 150/min booked
  const membership: { getActiveDiscountForGamer: ReturnType<typeof vi.fn> } = { getActiveDiscountForGamer: vi.fn(async () => null) };
  const subscriptions: { getWindowDiscountForGamer: ReturnType<typeof vi.fn> } = { getWindowDiscountForGamer: vi.fn(async () => null) };
  const wallet: Record<string, any> = {
    debitUpTo: vi.fn(async (_gamer: string, dto: { amount: number }) => dto.amount),
    getWalletForGamer: vi.fn(async () => ({ balance: 100_000 })),
    credited: new Subject(),
    debited: new Subject(),
    setReserveProvider: vi.fn(),
  };
  const commands: Record<string, ReturnType<typeof vi.fn>> = {
    issue: vi.fn(async () => ({})),
    issueSystemLock: vi.fn(async () => undefined),
    issueSessionUnlock: vi.fn(async () => true),
    issueSystemEndSession: vi.fn(async () => true),
  };
  const runoutTimer: Record<string, ReturnType<typeof vi.fn>> = {
    scheduleOrReschedule: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    isWithinWarning: vi.fn(() => false),
  };
  const port = new StationSessionPort();
  const config = {
    getOrThrow: () => 'test-jwt-secret',
    get: (key: string) =>
      ({ SESSION_LEASE_CAP_S, STATION_LEASE_S: LEASE_CAP_S, SESSION_PIN_MAX_ATTEMPTS: MAX_ATTEMPTS, SESSION_PIN_TTL_S: 900 })[key],
  };

  const notices = new SessionNoticesService(repo as any, agents as any, dashboard as any);
  const metering = new SessionMeteringService(
    repo as any, pricing as any, membership as any, subscriptions as any, wallet as any, commands as any, runoutTimer as any, config as any,
  );
  const runout = new SessionRunoutService(
    repo as any, presence as any, wallet as any, commands as any, runoutTimer as any, dashboard as any, metering, notices, config as any,
  );
  const login = new SessionLoginService(repo as any, metering, config as any);
  // The station-events queue, with a worker that runs each job as soon as it is added
  // (`autoRun = false` keeps jobs waiting, like a worker that is not running).
  const jobs: { name: string; data: any; opts: any }[] = [];
  const events = {
    autoRun: true,
    add: vi.fn(async (name: string, data: any, opts: any) => {
      jobs.push({ name, data, opts });
      if (events.autoRun) await processor.process({ name, data } as any);
    }),
  };
  const stationLink = new StationLinkService(
    repo as any, presence as any, commands as any, runoutTimer as any, metering, runout, dashboard as any, events as any, config as any,
  );
  const processor = new StationEventsProcessor(stationLink);
  const extensions = new SessionExtensionsService(repo as any, wallet as any, metering, runout, notices);
  const sweep = new SessionSweepService(repo as any, metering, notices, config as any);
  const queries = new SessionQueriesService(repo as any, wallet as any);
  const sessions = new SessionsService(login, metering, runout, stationLink, extensions, sweep, queries, port);

  for (const hook of [metering, runout, stationLink, sweep, sessions]) hook.onModuleInit();
  const destroy = () => {
    for (const hook of [runout, stationLink, sweep]) hook.onModuleDestroy();
  };

  return {
    repo, presence, agents, dashboard, pricing, membership, subscriptions, wallet, commands, runoutTimer, port,
    notices, metering, runout, login, stationLink, extensions, sweep, queries, sessions,
    events, jobs, processor,
    destroy,
  };
}

export type Harness = ReturnType<typeof createHarness>;

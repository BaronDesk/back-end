/**
 * Session money math, in one place so billing, the runout timer, quotes and
 * the gamer's "cost so far" can never disagree.
 *
 * A session's cost = `accruedCents` (time already charged at an earlier rate,
 * before a rate switch) + `meteredSeconds` at the current rate + the open
 * ACTIVE segment (from `meteringStartedAt`), split at `rateSwitchAt` when an
 * extension moved it to another rate. Metering never reaches past `endTime`.
 */
export interface Meter {
  status: string;
  meteredSeconds: number;
  meteringStartedAt: Date | null;
  rateCentsPerMinute: number | null;
  accruedCents: number;
  nextRateCentsPerMinute: number | null;
  rateSwitchAt: Date | null;
  endTime: Date;
}

export function secondsBetween(from: Date, to: Date): number {
  return Math.max(Math.round((to.getTime() - from.getTime()) / 1000), 0);
}

const centsFor = (seconds: number, centsPerMinute: number) => (seconds / 60) * centsPerMinute;

/** What the session has cost up to `at`, in millimes (unrounded). */
export function exactCostAt(m: Meter, at: Date): number {
  const rate = m.rateCentsPerMinute ?? 0;
  let cost = m.accruedCents + centsFor(m.meteredSeconds, rate);
  if (m.status !== 'ACTIVE' || !m.meteringStartedAt) return cost;

  const until = new Date(Math.min(at.getTime(), m.endTime.getTime()));
  const switchAt = m.rateSwitchAt && m.nextRateCentsPerMinute !== null ? m.rateSwitchAt : null;
  if (!switchAt || until <= switchAt) return cost + centsFor(secondsBetween(m.meteringStartedAt, until), rate);

  const before = m.meteringStartedAt < switchAt ? secondsBetween(m.meteringStartedAt, switchAt) : 0;
  const from = m.meteringStartedAt > switchAt ? m.meteringStartedAt : switchAt;
  cost += centsFor(before, rate) + centsFor(secondsBetween(from, until), m.nextRateCentsPerMinute!);
  return cost;
}

/** What the session has cost up to `at`, in whole millimes. */
export function costAt(m: Meter, at: Date): number {
  return Math.max(Math.round(exactCostAt(m, at)), 0);
}

/** The rate in force at `at`. */
export function rateAt(m: Meter, at: Date): number {
  if (m.rateSwitchAt && m.nextRateCentsPerMinute !== null && at >= m.rateSwitchAt) return m.nextRateCentsPerMinute;
  return m.rateCentsPerMinute ?? 0;
}

/**
 * The fields that fold a due rate switch into `accruedCents` (so the current
 * rate becomes the next one), or null when no switch is due at `now`. Run
 * before anything that changes metering state (pause, resume, settle).
 */
/** The metering fields a due rate switch rewrites. */
export type RateSwitchFold = Pick<
  Meter,
  'accruedCents' | 'meteredSeconds' | 'meteringStartedAt' | 'rateCentsPerMinute' | 'nextRateCentsPerMinute' | 'rateSwitchAt'
>;

export function foldDueRateSwitch(m: Meter, now: Date): RateSwitchFold | null {
  if (!m.rateSwitchAt || m.nextRateCentsPerMinute === null || now < m.rateSwitchAt) return null;
  const switchAt = m.rateSwitchAt;
  const rate = m.rateCentsPerMinute ?? 0;
  let seconds = m.meteredSeconds;
  let meteringStartedAt = m.meteringStartedAt;
  if (m.status === 'ACTIVE' && m.meteringStartedAt) {
    if (m.meteringStartedAt < switchAt) seconds += secondsBetween(m.meteringStartedAt, switchAt);
    meteringStartedAt = m.meteringStartedAt > switchAt ? m.meteringStartedAt : switchAt;
  }
  return {
    accruedCents: Math.round(m.accruedCents + centsFor(seconds, rate)),
    meteredSeconds: 0,
    meteringStartedAt,
    rateCentsPerMinute: m.nextRateCentsPerMinute,
    nextRateCentsPerMinute: null,
    rateSwitchAt: null,
  };
}

/**
 * How long, from `now`, until `money` (millimes) is spent at the session's
 * rates, a switch included. Infinity for free play.
 */
export function msUntilSpent(m: Meter, now: Date, money: number): number {
  if (money <= 0) return 0;
  const rate = rateAt(m, now);
  const switchAt = m.rateSwitchAt && m.nextRateCentsPerMinute !== null && m.rateSwitchAt > now ? m.rateSwitchAt : null;
  if (!switchAt) return rate > 0 ? (money / rate) * 60_000 : Number.POSITIVE_INFINITY;

  const beforeSwitchMs = switchAt.getTime() - now.getTime();
  const costToSwitch = (beforeSwitchMs / 60_000) * rate;
  if (rate > 0 && money <= costToSwitch) return (money / rate) * 60_000;
  const next = m.nextRateCentsPerMinute!;
  return next > 0 ? beforeSwitchMs + ((money - costToSwitch) / next) * 60_000 : Number.POSITIVE_INFINITY;
}

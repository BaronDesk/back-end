/**
 * Session money math, in one place so billing, the runout timer, quotes and
 * the gamer's "cost so far" can never disagree. Money is in coins (whole
 * numbers); rates are coins per hour, and time is billed by the second, so
 * an hour at 4000 coins/h costs exactly 4000 coins.
 *
 * A session's cost = `accruedCoins` (time already charged at an earlier rate,
 * before a rate switch) + `meteredSeconds` at the current rate + the open
 * ACTIVE segment (from `meteringStartedAt`), split at `rateSwitchAt` when an
 * extension moved it to another rate. Metering never reaches past `endTime`.
 */
export interface Meter {
  status: string;
  meteredSeconds: number;
  meteringStartedAt: Date | null;
  rateCoinsPerHour: number | null;
  accruedCoins: number;
  nextRateCoinsPerHour: number | null;
  rateSwitchAt: Date | null;
  endTime: Date;
}

const HOUR_MS = 3_600_000;

/** What `minutes` of play cost at `coinsPerHour`, in whole coins. */
export function coinsForMinutes(coinsPerHour: number, minutes: number): number {
  return Math.max(Math.round((coinsPerHour * minutes) / 60), 0);
}

export function secondsBetween(from: Date, to: Date): number {
  return Math.max(Math.round((to.getTime() - from.getTime()) / 1000), 0);
}

const coinsFor = (seconds: number, coinsPerHour: number) => (seconds / 3600) * coinsPerHour;

/** What the session has cost up to `at`, in coins (unrounded). */
export function exactCostAt(m: Meter, at: Date): number {
  const rate = m.rateCoinsPerHour ?? 0;
  let cost = m.accruedCoins + coinsFor(m.meteredSeconds, rate);
  if (m.status !== 'ACTIVE' || !m.meteringStartedAt) return cost;

  const until = new Date(Math.min(at.getTime(), m.endTime.getTime()));
  const switchAt = m.rateSwitchAt && m.nextRateCoinsPerHour !== null ? m.rateSwitchAt : null;
  if (!switchAt || until <= switchAt) return cost + coinsFor(secondsBetween(m.meteringStartedAt, until), rate);

  const before = m.meteringStartedAt < switchAt ? secondsBetween(m.meteringStartedAt, switchAt) : 0;
  const from = m.meteringStartedAt > switchAt ? m.meteringStartedAt : switchAt;
  cost += coinsFor(before, rate) + coinsFor(secondsBetween(from, until), m.nextRateCoinsPerHour!);
  return cost;
}

/** What the session has cost up to `at`, in whole coins. */
export function costAt(m: Meter, at: Date): number {
  return Math.max(Math.round(exactCostAt(m, at)), 0);
}

/** The rate in force at `at`. */
export function rateAt(m: Meter, at: Date): number {
  if (m.rateSwitchAt && m.nextRateCoinsPerHour !== null && at >= m.rateSwitchAt) return m.nextRateCoinsPerHour;
  return m.rateCoinsPerHour ?? 0;
}

/**
 * The fields that fold a due rate switch into `accruedCoins` (so the current
 * rate becomes the next one), or null when no switch is due at `now`. Run
 * before anything that changes metering state (pause, resume, settle).
 */
/** The metering fields a due rate switch rewrites. */
export type RateSwitchFold = Pick<
  Meter,
  'accruedCoins' | 'meteredSeconds' | 'meteringStartedAt' | 'rateCoinsPerHour' | 'nextRateCoinsPerHour' | 'rateSwitchAt'
>;

export function foldDueRateSwitch(m: Meter, now: Date): RateSwitchFold | null {
  if (!m.rateSwitchAt || m.nextRateCoinsPerHour === null || now < m.rateSwitchAt) return null;
  const switchAt = m.rateSwitchAt;
  const rate = m.rateCoinsPerHour ?? 0;
  let seconds = m.meteredSeconds;
  let meteringStartedAt = m.meteringStartedAt;
  if (m.status === 'ACTIVE' && m.meteringStartedAt) {
    if (m.meteringStartedAt < switchAt) seconds += secondsBetween(m.meteringStartedAt, switchAt);
    meteringStartedAt = m.meteringStartedAt > switchAt ? m.meteringStartedAt : switchAt;
  }
  return {
    accruedCoins: Math.round(m.accruedCoins + coinsFor(seconds, rate)),
    meteredSeconds: 0,
    meteringStartedAt,
    rateCoinsPerHour: m.nextRateCoinsPerHour,
    nextRateCoinsPerHour: null,
    rateSwitchAt: null,
  };
}

/**
 * How long, from `now`, until `money` (coins) is spent at the session's
 * rates, a switch included. Infinity for free play.
 */
export function msUntilSpent(m: Meter, now: Date, money: number): number {
  if (money <= 0) return 0;
  const rate = rateAt(m, now);
  const switchAt = m.rateSwitchAt && m.nextRateCoinsPerHour !== null && m.rateSwitchAt > now ? m.rateSwitchAt : null;
  if (!switchAt) return rate > 0 ? (money / rate) * HOUR_MS : Number.POSITIVE_INFINITY;

  const beforeSwitchMs = switchAt.getTime() - now.getTime();
  const costToSwitch = (beforeSwitchMs / HOUR_MS) * rate;
  if (rate > 0 && money <= costToSwitch) return (money / rate) * HOUR_MS;
  const next = m.nextRateCoinsPerHour!;
  return next > 0 ? beforeSwitchMs + ((money - costToSwitch) / next) * HOUR_MS : Number.POSITIVE_INFINITY;
}

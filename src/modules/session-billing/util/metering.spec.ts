import { describe, expect, it } from 'vitest';

import { costAt, foldDueRateSwitch, msUntilSpent, type Meter } from './metering.js';

const T0 = new Date('2026-09-30T18:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function meter(overrides: Partial<Meter> = {}): Meter {
  return {
    status: 'ACTIVE',
    meteredSeconds: 0,
    meteringStartedAt: T0,
    rateCentsPerMinute: 100,
    accruedCents: 0,
    nextRateCentsPerMinute: null,
    rateSwitchAt: null,
    endTime: at(60),
    ...overrides,
  };
}

describe('metering', () => {
  it('costs earlier metered time plus the running segment, never past the end', () => {
    expect(costAt(meter({ meteredSeconds: 600 }), at(5))).toBe(1500); // 10 min before + 5 min now
    expect(costAt(meter(), at(90))).toBe(6000); // capped at the 60 min window
    expect(costAt(meter({ status: 'PAUSED', meteredSeconds: 120 }), at(30))).toBe(200);
  });

  it('splits the running segment at a rate switch', () => {
    const m = meter({ endTime: at(90), rateSwitchAt: at(60), nextRateCentsPerMinute: 150 });
    expect(costAt(m, at(30))).toBe(3000);
    expect(costAt(m, at(80))).toBe(6000 + 20 * 150);
  });

  it('folds a due switch into accrued money, keeping the total', () => {
    const m = meter({ meteredSeconds: 300, endTime: at(90), rateSwitchAt: at(60), nextRateCentsPerMinute: 150 });
    const now = at(70);
    const folded = { ...m, ...foldDueRateSwitch(m, now)! };
    expect(folded).toMatchObject({ accruedCents: 500 + 6000, meteredSeconds: 0, rateCentsPerMinute: 150, rateSwitchAt: null });
    expect(folded.meteringStartedAt).toEqual(at(60));
    expect(costAt(folded, now)).toBe(costAt(m, now));
    expect(foldDueRateSwitch(m, at(30))).toBeNull();
  });

  it('tells how long money lasts, across a switch', () => {
    expect(msUntilSpent(meter(), T0, 1000)).toBe(10 * 60_000);
    const m = meter({ endTime: at(90), rateSwitchAt: at(10), nextRateCentsPerMinute: 200 });
    expect(msUntilSpent(m, T0, 1000 + 2000)).toBe(20 * 60_000); // 10 min at 100, then 10 min at 200
    expect(msUntilSpent(meter({ rateCentsPerMinute: 0 }), T0, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(msUntilSpent(meter(), T0, 0)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import { costAt, foldDueRateSwitch, msUntilSpent, type Meter } from './metering.js';

const T0 = new Date('2026-09-30T18:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function meter(overrides: Partial<Meter> = {}): Meter {
  return {
    status: 'ACTIVE',
    meteredSeconds: 0,
    meteringStartedAt: T0,
    rateCoinsPerHour: 6000,
    accruedCoins: 0,
    nextRateCoinsPerHour: null,
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
    const m = meter({ endTime: at(90), rateSwitchAt: at(60), nextRateCoinsPerHour: 9000 });
    expect(costAt(m, at(30))).toBe(3000);
    expect(costAt(m, at(80))).toBe(6000 + 3000); // 20 min at 9000/h
  });

  it('folds a due switch into accrued money, keeping the total', () => {
    const m = meter({ meteredSeconds: 300, endTime: at(90), rateSwitchAt: at(60), nextRateCoinsPerHour: 9000 });
    const now = at(70);
    const folded = { ...m, ...foldDueRateSwitch(m, now)! };
    expect(folded).toMatchObject({ accruedCoins: 500 + 6000, meteredSeconds: 0, rateCoinsPerHour: 9000, rateSwitchAt: null });
    expect(folded.meteringStartedAt).toEqual(at(60));
    expect(costAt(folded, now)).toBe(costAt(m, now));
    expect(foldDueRateSwitch(m, at(30))).toBeNull();
  });

  it('bills an hourly rate by the second, with no per-minute rounding', () => {
    const fourPerHour = meter({ rateCoinsPerHour: 4000, meteredSeconds: 3600, status: 'PAUSED' });
    expect(costAt(fourPerHour, at(0))).toBe(4000); // 66.67/min would round to 67, i.e. 4020 an hour
    expect(costAt(meter({ rateCoinsPerHour: 4000, meteredSeconds: 15 * 60, status: 'PAUSED' }), at(0))).toBe(1000);
    expect(costAt(meter({ rateCoinsPerHour: 4000, meteredSeconds: 7 * 60, status: 'PAUSED' }), at(0))).toBe(467);
  });

  it('tells how long money lasts, across a switch', () => {
    expect(msUntilSpent(meter(), T0, 1000)).toBe(10 * 60_000);
    const m = meter({ endTime: at(90), rateSwitchAt: at(10), nextRateCoinsPerHour: 12000 });
    expect(msUntilSpent(m, T0, 1000 + 2000)).toBe(20 * 60_000); // 10 min at 6000/h, then 10 min at 12000/h
    expect(msUntilSpent(meter({ rateCoinsPerHour: 0 }), T0, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(msUntilSpent(meter(), T0, 0)).toBe(0);
  });
});

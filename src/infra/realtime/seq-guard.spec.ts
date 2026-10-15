import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeDrop, REPLAY_WINDOW_MS, SeqGuard } from './seq-guard.js';

describe('SeqGuard', () => {
  const NOW = Date.parse('2026-10-15T10:00:00.000Z');
  let guard: SeqGuard;
  let seq: number;
  const at = (skewMs: number) => guard.check({ seq: ++seq, ts: NOW + skewMs });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    guard = new SeqGuard();
    seq = 0;
  });

  afterEach(() => vi.useRealTimers());

  it('has a 30 s window', () => {
    expect(REPLAY_WINDOW_MS).toBe(30_000);
  });

  it('accepts frames whose ts is off by less than the window, either way, and at its edge', () => {
    for (const skew of [0, -1_000, 1_000, -29_999, 29_999, -REPLAY_WINDOW_MS, REPLAY_WINDOW_MS]) {
      expect(at(skew)).toEqual({ ok: true });
    }
  });

  it('drops frames whose ts is off by more than the window, either way, with the skew', () => {
    expect(at(-REPLAY_WINDOW_MS - 1)).toEqual({ ok: false, reason: 'ts_out_of_window', skewMs: -30_001 });
    expect(at(45_000)).toEqual({ ok: false, reason: 'ts_out_of_window', skewMs: 45_000 });
    expect(at(-10 * 60_000)).toMatchObject({ ok: false, reason: 'ts_out_of_window' });
  });

  it('does not advance the seq on a dropped frame: the next in-window frame is still accepted', () => {
    expect(at(-60_000).ok).toBe(false);
    expect(guard.check({ seq, ts: NOW })).toEqual({ ok: true }); // same seq as the dropped one
  });

  it('drops a replayed or older seq even with a fresh ts', () => {
    expect(guard.check({ seq: 5, ts: NOW })).toEqual({ ok: true });
    expect(guard.check({ seq: 5, ts: NOW })).toEqual({ ok: false, reason: 'seq_replay' });
    expect(guard.check({ seq: 4, ts: NOW })).toEqual({ ok: false, reason: 'seq_replay' });
  });

  it('describes a timestamp drop for the log, and nothing for a seq replay', () => {
    expect(describeDrop({ ok: false, reason: 'ts_out_of_window', skewMs: -45_000 })).toBe('ts 45.0s behind server time, window ±30s');
    expect(describeDrop({ ok: false, reason: 'ts_out_of_window', skewMs: 31_200 })).toBe('ts 31.2s ahead of server time, window ±30s');
    expect(describeDrop({ ok: false, reason: 'seq_replay' })).toBeNull();
  });
});

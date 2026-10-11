import { describe, expect, it } from 'vitest';

import { xpForSeconds } from './xp.js';

describe('xpForSeconds', () => {
  it('gives 25 XP for every 15 minutes played', () => {
    expect(xpForSeconds(15 * 60)).toBe(25);
    expect(xpForSeconds(60 * 60)).toBe(100);
    expect(xpForSeconds(2 * 60 * 60)).toBe(200);
  });

  it('counts part of a block by the second, rounded down to whole XP', () => {
    expect(xpForSeconds(7 * 60)).toBe(11); // 11.67
    expect(xpForSeconds(36)).toBe(1);
    expect(xpForSeconds(35)).toBe(0);
  });

  it('gives nothing for no play', () => {
    expect(xpForSeconds(0)).toBe(0);
    expect(xpForSeconds(-5)).toBe(0);
  });
});

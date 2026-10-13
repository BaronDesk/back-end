import { describe, expect, it } from 'vitest';

import { rankForXp } from './rank-for-xp.js';

const rank = (name: string, minXp: number) => ({ id: name.toLowerCase(), name, minXp, badgeUrl: null });
const wood = rank('Wood', 0);
const bronze = rank('Bronze', 500);
const silver = rank('Silver', 1500);
// Out of order on purpose: the ladder is sorted by minXp, not by how it arrives.
const ranks = [silver, wood, bronze];

describe('rankForXp', () => {
  it('gives the highest rank reached and the next one to aim for', () => {
    expect(rankForXp(15, ranks)).toEqual({ rank: wood, nextRank: bronze });
    expect(rankForXp(700, ranks)).toEqual({ rank: bronze, nextRank: silver });
  });

  it('counts a rank as reached at exactly its minXp', () => {
    expect(rankForXp(500, ranks)).toEqual({ rank: bronze, nextRank: silver });
  });

  it('has no next rank at the top', () => {
    expect(rankForXp(99_999, ranks)).toEqual({ rank: silver, nextRank: null });
  });

  it('has no rank yet below the lowest one', () => {
    expect(rankForXp(100, [bronze, silver])).toEqual({ rank: null, nextRank: bronze });
  });

  it('has neither when no rank exists', () => {
    expect(rankForXp(100, [])).toEqual({ rank: null, nextRank: null });
  });

  it('sends only what the gamer is shown of a rank', () => {
    const stored = { ...wood, createdAt: new Date(), updatedAt: new Date() };
    expect(Object.keys(rankForXp(0, [stored]).rank!)).toEqual(['id', 'name', 'minXp', 'badgeUrl']);
  });
});

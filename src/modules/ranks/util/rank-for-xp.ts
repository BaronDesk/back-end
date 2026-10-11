/** What a gamer is shown of a rank: its name, where it starts, its badge. */
export interface RankRef {
  id: string;
  name: string;
  minXp: number;
  badgeUrl: string | null;
}

/**
 * The gamer's rank is the highest one whose minXp is at or below their XP;
 * the next one is what their XP bar fills towards (null at the top rank).
 * Below the lowest rank (an admin raised its minXp) there is no rank yet.
 */
export function rankForXp(xp: number, ranks: readonly RankRef[]): { rank: RankRef | null; nextRank: RankRef | null } {
  const ladder = [...ranks].sort((a, b) => a.minXp - b.minXp);
  const next = ladder.findIndex((r) => r.minXp > xp);
  const reached = next === -1 ? ladder.length : next;
  return {
    rank: reached > 0 ? toRef(ladder[reached - 1]) : null,
    nextRank: next === -1 ? null : toRef(ladder[next]),
  };
}

const toRef = ({ id, name, minXp, badgeUrl }: RankRef): RankRef => ({ id, name, minXp, badgeUrl });

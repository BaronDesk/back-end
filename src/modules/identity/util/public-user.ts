import { rankForXp, type RankRef } from '../../ranks/util/rank-for-xp.js';

export interface UserWithProfiles {
  id: string;
  username: string;
  role: string;
  accountStatus: string;
  createdAt: Date;
  employeeProfile?: { managedBranchId: string | null } | null;
  gamerProfile?: { id: string; homeBranchId: string | null; avatarUrl?: string | null; xp?: number } | null;
}

/** `ranks`: every rank (GET /ranks), to place a gamer's XP on the ladder. Unused for staff. */
export function toPublicUser(user: UserWithProfiles, ranks: readonly RankRef[]) {
  const xp = user.gamerProfile ? (user.gamerProfile.xp ?? 0) : null;
  const { rank, nextRank } = xp === null ? { rank: null, nextRank: null } : rankForXp(xp, ranks);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    accountStatus: user.accountStatus,
    /** The branch a staff member works at. */
    branchId: user.employeeProfile?.managedBranchId ?? null,
    /** A gamer's profile id (their wallet and bookings hang off it). */
    gamerProfileId: user.gamerProfile?.id ?? null,
    /** The branch a gamer plays at: the booking page lists its stations. */
    homeBranchId: user.gamerProfile?.homeBranchId ?? null,
    /** A gamer's profile picture (/uploads/avatars/<id>.webp), or null. */
    avatarUrl: user.gamerProfile?.avatarUrl ?? null,
    /** A gamer's XP; null for staff. */
    xp,
    /** The highest rank the gamer's XP has reached, or null (staff, or below the lowest rank). */
    rank,
    /** The rank the XP bar fills towards; null at the top rank and for staff. */
    nextRank,
    createdAt: user.createdAt,
  };
}

/** Only gamers have a rank: staff-only results need no ranks loaded. */
export const needsRanks = (users: readonly UserWithProfiles[]) => users.some((u) => u.gamerProfile);

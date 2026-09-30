export interface UserWithProfiles {
  id: string;
  username: string;
  role: string;
  accountStatus: string;
  createdAt: Date;
  employeeProfile?: { managedBranchId: string | null } | null;
  gamerProfile?: { id: string; homeBranchId: string | null } | null;
}

export function toPublicUser(user: UserWithProfiles) {
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
    createdAt: user.createdAt,
  };
}

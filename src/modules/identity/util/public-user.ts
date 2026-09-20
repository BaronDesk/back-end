export interface UserWithEmployeeProfile {
  id: string;
  username: string;
  role: string;
  accountStatus: string;
  createdAt: Date;
  employeeProfile?: { managedBranchId: string | null } | null;
}

export function toPublicUser(user: UserWithEmployeeProfile) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    accountStatus: user.accountStatus,
    branchId: user.employeeProfile?.managedBranchId ?? null,
    createdAt: user.createdAt,
  };
}

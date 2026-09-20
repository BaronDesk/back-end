export type Role = 'GAMER' | 'EMPLOYEE' | 'MANAGER' | 'ADMIN';
export type Scope = 'self' | 'staff' | 'admin' | 'hq';

export const ROLE_SCOPE: Record<Role, Scope> = {
  GAMER: 'self',
  EMPLOYEE: 'staff',
  MANAGER: 'admin',
  ADMIN: 'hq',
};

export const SCOPE_RANK: Record<'public' | Scope, number> = {
  public: 0,
  self: 1,
  staff: 2,
  admin: 3,
  hq: 4,
};

import type { Role, Scope } from '../utils/scope.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  scope: Scope;
  branchId: string | null;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface StationTokenPayload {
  sub: string;
  type: 'station';
  serialNumber: string;
  branchId: string;
  /** Machine.credentialVersion when issued; missing on tokens issued before versions (= 1). */
  ver?: number;
  iat?: number;
  exp?: number;
}

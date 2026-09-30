import { describe, expect, it } from 'vitest';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { roomFor } from './dashboard.gateway.js';

const user = (overrides: Partial<AccessTokenPayload>): AccessTokenPayload =>
  ({ sub: 'u1', role: 'GAMER', scope: 'self', branchId: null, jti: 'j', ...overrides }) as AccessTokenPayload;

describe('dashboard rooms', () => {
  it('keeps a gamer in their own room: no branch events', () => {
    expect(roomFor(user({}))).toBe('user:u1');
  });

  it('puts branch staff in their branch, HQ in every branch, and a branch-less employee nowhere', () => {
    expect(roomFor(user({ role: 'EMPLOYEE', scope: 'staff', branchId: 'b1' }))).toBe('branch:b1');
    expect(roomFor(user({ role: 'MANAGER', scope: 'admin', branchId: 'b2' }))).toBe('branch:b2');
    expect(roomFor(user({ role: 'ADMIN', scope: 'hq' }))).toBe('branch:all');
    expect(roomFor(user({ role: 'EMPLOYEE', scope: 'staff', branchId: null }))).toBeNull();
  });
});

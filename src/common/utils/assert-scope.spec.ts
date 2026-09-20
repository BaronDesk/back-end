import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

import { assertScope } from './assert-scope.js';
import type { AccessTokenPayload } from '../types/jwt-payload.js';

function caller(overrides: Partial<AccessTokenPayload>): AccessTokenPayload {
  return {
    sub: 'caller-id',
    role: 'EMPLOYEE',
    scope: 'staff',
    branchId: 'branch-a',
    jti: 'jti-1',
    ...overrides,
  };
}

describe('assertScope', () => {
  it('allows staff acting within their own branch', () => {
    expect(() => assertScope(caller({ scope: 'staff', branchId: 'branch-a' }), { branchId: 'branch-a' })).not.toThrow();
  });

  it('rejects staff acting on a different branch', () => {
    expect(() => assertScope(caller({ scope: 'staff', branchId: 'branch-a' }), { branchId: 'branch-b' })).toThrow(
      ForbiddenException,
    );
  });

  it('lets hq bypass every branch and ownership check', () => {
    expect(() =>
      assertScope(caller({ scope: 'hq', branchId: null }), { branchId: 'branch-b', userId: 'someone-else' }),
    ).not.toThrow();
  });

  it('lets self act on their own resource', () => {
    expect(() =>
      assertScope(caller({ scope: 'self', branchId: null, sub: 'user-1' }), { userId: 'user-1' }),
    ).not.toThrow();
  });

  it('rejects self acting on someone else\'s resource', () => {
    expect(() =>
      assertScope(caller({ scope: 'self', branchId: null, sub: 'user-1' }), { userId: 'user-2' }),
    ).toThrow(ForbiddenException);
  });
});

import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { TokenService } from '../../identity/services/token.service.js';
import { InvalidStationTokenError, StationTokenService } from './station-token.service.js';

const SECRET = 'test-access-secret';
const config = {
  getOrThrow: (key: string) =>
    ({ JWT_ACCESS_SECRET: SECRET, JWT_ACCESS_TTL: '15m', JWT_REFRESH_SECRET: 'r', JWT_REFRESH_TTL: '7d' })[key],
};
const jwt = new JwtService();
const tokens = new TokenService(jwt, config as any);
const service = new StationTokenService(tokens);

const machineId = randomUUID();
const branchId = randomUUID();
const stationClaims = { sub: machineId, type: 'station', serialNumber: 'SN-1', branchId };
const sign = (claims: object, options: { secret?: string; expiresIn?: number } = {}) =>
  jwt.sign(claims, { secret: options.secret ?? SECRET, expiresIn: options.expiresIn ?? 3600 });

describe('StationTokenService', () => {
  it('returns the principal from a valid station token', async () => {
    await expect(service.verify(sign(stationClaims))).resolves.toEqual({ machineId, serialNumber: 'SN-1', branchId });
  });

  it.each([
    ['missing', null],
    ['garbage', 'not.a.jwt'],
    ['expired', sign(stationClaims, { expiresIn: -10 })],
    ['signed with another key', sign(stationClaims, { secret: 'other-secret' })],
    ['a user access token', sign({ sub: randomUUID(), role: 'EMPLOYEE', scope: 'staff', branchId, jti: randomUUID() })],
    ['a station token without exp', jwt.sign(stationClaims, { secret: SECRET })],
    ['a station token with a non-uuid machineId', sign({ ...stationClaims, sub: 'm-1' })],
  ])('rejects %s', async (_label, token) => {
    await expect(service.verify(token)).rejects.toBeInstanceOf(InvalidStationTokenError);
  });
});

describe('TokenService.verifyAccessToken', () => {
  it('does not accept a station token as a user', async () => {
    await expect(tokens.verifyAccessToken(sign(stationClaims))).rejects.toThrow();
  });

  it('still accepts a user access token', async () => {
    const claims = tokens.buildAccessClaims({ id: randomUUID(), role: 'EMPLOYEE', branchId }, randomUUID());
    await expect(tokens.verifyAccessToken(tokens.signAccessToken(claims))).resolves.toMatchObject({ role: 'EMPLOYEE' });
  });
});

import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('user profiles (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let branchId: string;
  let otherBranchId: string;

  const password = 'super-secret-1';
  const managerUsername = `mgr-${randomUUID()}`;
  const employeeUsername = `emp-${randomUUID()}`;
  const gamerUsername = `gamer-${randomUUID()}`;

  let managerToken: string;
  let employeeId: string;
  let gamerId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const login = async (username: string) => {
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    return res.json();
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);

    const branch = await prisma.branch.create({ data: { name: `branch-${randomUUID()}`, location: 'test' } });
    branchId = branch.id;
    const other = await prisma.branch.create({ data: { name: `branch-${randomUUID()}`, location: 'test' } });
    otherBranchId = other.id;

    const passwordHash = await hash(password);
    await prisma.user.create({
      data: {
        username: managerUsername,
        passwordHash,
        role: 'MANAGER',
        employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } },
      },
    });
    const employee = await prisma.user.create({
      data: {
        username: employeeUsername,
        passwordHash,
        role: 'EMPLOYEE',
        employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } },
      },
    });
    employeeId = employee.id;
    const gamer = await prisma.user.create({
      data: { username: gamerUsername, passwordHash, role: 'GAMER', gamerProfile: { create: {} } },
    });
    gamerId = gamer.id;

    managerToken = (await login(managerUsername)).accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: [managerUsername, employeeUsername, gamerUsername] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    await app.close();
  });

  describe('GET /users', () => {
    it('lets a manager list their own branch, and blocks another branch', async () => {
      const mine = await app.inject({ method: 'GET', url: '/users', headers: auth(managerToken) });
      expect(mine.statusCode).toBe(200);
      expect(mine.json().some((u: { id: string }) => u.id === employeeId)).toBe(true);

      const other = await app.inject({
        method: 'GET',
        url: `/users?branchId=${otherBranchId}`,
        headers: auth(managerToken),
      });
      expect(other.statusCode).toBe(403);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'GET', url: '/users' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /users/:id/status', () => {
    it('lets a manager suspend an employee in their own branch', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${employeeId}/status`,
        headers: auth(managerToken),
        payload: { accountStatus: 'SUSPENDED' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().accountStatus).toBe('SUSPENDED');
    });

    it('blocks a manager from suspending a gamer account', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${gamerId}/status`,
        headers: auth(managerToken),
        payload: { accountStatus: 'SUSPENDED' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('blocks a manager from changing their own status', async () => {
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(managerToken) });
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${me.json().id}/status`,
        headers: auth(managerToken),
        payload: { accountStatus: 'SUSPENDED' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PATCH /users/:id/employment-status', () => {
    it('rejects a target with no employee profile', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${gamerId}/employment-status`,
        headers: auth(managerToken),
        payload: { employmentStatus: 'TERMINATED' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('lets a manager change employment status within their own branch', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/users/${employeeId}/employment-status`,
        headers: auth(managerToken),
        payload: { employmentStatus: 'ON_LEAVE' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().employmentStatus).toBe('ON_LEAVE');
    });
  });

  describe('PATCH /auth/password', () => {
    it('rejects the wrong current password', async () => {
      const session = await login(employeeUsername);
      const res = await app.inject({
        method: 'PATCH',
        url: '/auth/password',
        headers: auth(session.accessToken),
        payload: { currentPassword: 'not-the-real-password', newPassword: 'brand-new-password-1' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('changes the password and revokes other sessions, including the refresh token used to change it', async () => {
      const session = await login(employeeUsername);

      const change = await app.inject({
        method: 'PATCH',
        url: '/auth/password',
        headers: auth(session.accessToken),
        payload: { currentPassword: password, newPassword: 'brand-new-password-1' },
      });
      expect(change.statusCode).toBe(200);

      // old password no longer works
      const oldLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: employeeUsername, password },
      });
      expect(oldLogin.statusCode).toBe(401);

      // the refresh token issued before the change is now revoked
      const refreshAttempt = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: session.refreshToken },
      });
      expect(refreshAttempt.statusCode).toBe(401);

      // new password works
      const newLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { username: employeeUsername, password: 'brand-new-password-1' },
      });
      expect(newLogin.statusCode).toBe(200);
    });
  });
});

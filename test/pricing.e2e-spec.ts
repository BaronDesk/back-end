import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('pricing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let branchAId: string;
  let branchBId: string;
  let gamerToken: string;
  let managerToken: string; // manages branch A
  let adminToken: string;

  const password = 'super-secret-1';
  const gamerUsername = `gamer-${randomUUID()}`;
  const managerUsername = `manager-${randomUUID()}`;
  const adminUsername = `admin-${randomUUID()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    const branchA = await prisma.branch.create({ data: { name: `Branch A ${randomUUID()}`, location: 'A' } });
    const branchB = await prisma.branch.create({ data: { name: `Branch B ${randomUUID()}`, location: 'B' } });
    branchAId = branchA.id;
    branchBId = branchB.id;

    const passwordHash = await hash(password);
    await prisma.user.create({ data: { username: adminUsername, passwordHash, role: 'ADMIN' } });
    await prisma.user.create({
      data: {
        username: managerUsername, passwordHash, role: 'MANAGER',
        employeeProfile: { create: { managedBranchId: branchAId, hireDate: new Date() } },
      },
    });
    await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password, branchId: branchAId } });

    const login = async (username: string) =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken;

    gamerToken = await login(gamerUsername);
    managerToken = await login(managerUsername);
    adminToken = await login(adminUsername);
  }, 30_000);

  afterAll(async () => {
    await prisma.pricing.deleteMany({ where: { branchId: { in: [branchAId, branchBId] } } });
    await prisma.user.deleteMany({ where: { username: { in: [gamerUsername, managerUsername, adminUsername] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
    await app.close();
  });

  it('rejects a gamer', async () => {
    const res = await app.inject({
      method: 'GET', url: `/branches/${branchAId}/pricing`,
      headers: { authorization: `Bearer ${gamerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s before any pricing is set', async () => {
    const res = await app.inject({
      method: 'GET', url: `/branches/${branchAId}/pricing`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a manager setting pricing for a branch they do not manage', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/branches/${branchBId}/pricing`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { paygRate: 10, bookingRate: 25 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a manager set pricing for their own branch', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/branches/${branchAId}/pricing`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { paygRate: 10000, bookingRate: 25000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paygRate: 10000, bookingRate: 25000 });
  });

  it('overwrites on a second PUT instead of duplicating the row', async () => {
    await app.inject({
      method: 'PUT', url: `/branches/${branchAId}/pricing`,
      headers: { authorization: `Bearer ${managerToken}` },
      payload: { paygRate: 12000, bookingRate: 30000 },
    });
    const rows = await prisma.pricing.findMany({ where: { branchId: branchAId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].paygRate).toBe(12000);
  });

  it('lets admin set pricing for any branch', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/branches/${branchBId}/pricing`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { paygRate: 9000, bookingRate: 20000 },
    });
    expect(res.statusCode).toBe(200);
  });
});

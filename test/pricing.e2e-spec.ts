import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('pricing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let branchId: string;
  let gamerToken: string;
  let managerToken: string;
  let adminToken: string;
  // The price list is one row shared by every spec: put it back afterwards.
  let saved: { paygRate: number; bookingRate: number } | null = null;

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

    const existing = await prisma.pricing.findUnique({ where: { id: 1 } });
    if (existing) saved = { paygRate: existing.paygRate, bookingRate: existing.bookingRate };
    await prisma.pricing.deleteMany({});

    const branch = await prisma.branch.create({ data: { name: `Branch ${randomUUID()}`, location: 'A' } });
    branchId = branch.id;

    const passwordHash = await hash(password);
    await prisma.user.create({ data: { username: adminUsername, passwordHash, role: 'ADMIN' } });
    await prisma.user.create({
      data: {
        username: managerUsername, passwordHash, role: 'MANAGER',
        employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } },
      },
    });
    await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password, branchId } });

    const login = async (username: string) =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken;

    gamerToken = await login(gamerUsername);
    managerToken = await login(managerUsername);
    adminToken = await login(adminUsername);
  }, 30_000);

  afterAll(async () => {
    await prisma.pricing.deleteMany({});
    if (saved) await prisma.pricing.create({ data: { id: 1, ...saved } });
    await prisma.user.deleteMany({ where: { username: { in: [gamerUsername, managerUsername, adminUsername] } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await app.close();
  });

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  it('404s before any price is set', async () => {
    const res = await app.inject({ method: 'GET', url: '/pricing', headers: as(adminToken) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'PRICING_NOT_SET' });
  });

  it('refuses a manager: the prices apply in every branch, so only HQ sets them', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/pricing', headers: as(managerToken),
      payload: { paygRate: 4000, bookingRate: 4000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets HQ set the prices, and audits it', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/pricing', headers: as(adminToken),
      payload: { paygRate: 4000, bookingRate: 4000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paygRate: 4000, bookingRate: 4000 });
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: adminUsername } });
    expect(await prisma.auditLog.count({ where: { userId: admin.id, target: 'pricing' } })).toBe(1);
  });

  it('keeps a single row: a second PUT overwrites it', async () => {
    await app.inject({
      method: 'PUT', url: '/pricing', headers: as(adminToken),
      payload: { paygRate: 5000, bookingRate: 6000 },
    });
    const rows = await prisma.pricing.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, paygRate: 5000, bookingRate: 6000 });
  });

  it('shows the prices to anyone signed in, a gamer too', async () => {
    const res = await app.inject({ method: 'GET', url: '/pricing', headers: as(gamerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ paygRate: 5000, bookingRate: 6000 });
  });

  it('refuses a rate that is not whole coins', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/pricing', headers: as(adminToken),
      payload: { paygRate: 4000.5, bookingRate: 4000 },
    });
    expect(res.statusCode).toBe(400);
  });
});

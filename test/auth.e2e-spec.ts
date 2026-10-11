import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('auth + rbac (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let branchId: string;

  const password = 'super-secret-1';
  const gamerUsername = `gamer-${randomUUID()}`;
  const adminUsername = `admin-${randomUUID()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);

    const branch = await prisma.branch.create({ data: { name: `branch-${randomUUID()}`, location: 'test' } });
    branchId = branch.id;

    const passwordHash = await hash(password);
    await prisma.user.create({
      data: { username: adminUsername, passwordHash, role: 'ADMIN' },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: [gamerUsername, adminUsername] } } });
    await prisma.branch.delete({ where: { id: branchId } }).catch(() => undefined);
    await app.close();
  });

  it('refuses a sign-up without a home branch, or with an unknown one', async () => {
    const missing = await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('VALIDATION_ERROR');

    const unknown = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { username: gamerUsername, password, branchId: randomUUID() },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('BRANCH_NOT_FOUND');
  });

  it('registers a gamer via POST /users with their home branch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { username: gamerUsername, password, branchId },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: gamerUsername, role: 'GAMER', homeBranchId: branchId });
  });

  it('logs the gamer in with 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: gamerUsername, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
  });

  it('rejects bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: gamerUsername, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a gamer creating an employee — wrong scope gets 403', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: gamerUsername, password },
    });
    const { accessToken } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { username: `emp-${randomUUID()}`, password, role: 'EMPLOYEE', branchId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows an hq admin to create an employee — right scope gets 200/201', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: adminUsername, password },
    });
    const { accessToken } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/employees',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { username: `emp-${randomUUID()}`, password, role: 'EMPLOYEE', branchId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects requests with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it("sends the gamer's XP, rank and next rank on /auth/me, and none for staff", async () => {
    // Far above the seeded ranks, so the result doesn't depend on them.
    const base = 900_000_000;
    const names = [`rank-${randomUUID()}`, `rank-${randomUUID()}`];
    await prisma.rank.createMany({ data: [{ name: names[0], minXp: base }, { name: names[1], minXp: base + 1000 }] });
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { username: gamerUsername } });
      await prisma.gamerProfile.update({ where: { userId: user.id }, data: { xp: base + 15 } });

      const login = async (username: string) =>
        (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken;
      const me = async (username: string) =>
        (await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${await login(username)}` } })).json();

      expect(await me(gamerUsername)).toMatchObject({
        xp: base + 15,
        rank: { name: names[0], minXp: base, badgeUrl: null },
        nextRank: { name: names[1], minXp: base + 1000 },
      });
      expect(await me(adminUsername)).toMatchObject({ xp: null, rank: null, nextRank: null });
    } finally {
      await prisma.rank.deleteMany({ where: { name: { in: names } } });
    }
  });
});

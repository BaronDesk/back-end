import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('wallet ledger (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let gamerProfileId: string;
  let gamerToken: string;
  let adminToken: string;

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

    const passwordHash = await hash(password);
    await prisma.user.create({ data: { username: adminUsername, passwordHash, role: 'ADMIN' } });

    await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password } });

    const gamerLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: gamerUsername, password },
    });
    gamerToken = gamerLogin.json().accessToken;

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: adminUsername, password },
    });
    adminToken = adminLogin.json().accessToken;

    const gamerUser = await prisma.user.findUniqueOrThrow({
      where: { username: gamerUsername },
      include: { gamerProfile: true },
    });
    gamerProfileId = gamerUser.gamerProfile!.id;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: [gamerUsername, adminUsername] } } });
    await app.close();
  });

  it('lazily creates a zero-balance wallet on first "me" access', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wallets/me',
      headers: { authorization: `Bearer ${gamerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ gamerProfileId, balance: 0 });
  });

  it('rejects a gamer hitting a staff-scoped wallet route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}`,
      headers: { authorization: `Bearer ${gamerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets staff credit a wallet, moving the balance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${gamerProfileId}/credit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 1000 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: 1000, balanceAfter: 1000, type: 'CREDIT' });
  });

  it('lets staff debit a wallet with sufficient funds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${gamerProfileId}/debit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 300 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ amount: -300, balanceAfter: 700, type: 'DEBIT' });
  });

  it('rejects a debit that would overdraw the wallet, balance unchanged', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${gamerProfileId}/debit`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { amount: 999_999 },
    });
    expect(res.statusCode).toBe(409);

    const after = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().balance).toBe(before.json().balance);
  });

  it('posts an idempotencyKey exactly once under concurrent retries', async () => {
    const idempotencyKey = `topup-${randomUUID()}`;
    const before = (
      await app.inject({
        method: 'GET',
        url: `/wallets/${gamerProfileId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().balance;

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/wallets/${gamerProfileId}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: 500, idempotencyKey },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${gamerProfileId}/credit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount: 500, idempotencyKey },
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().id).toBe(second.json().id); // same entry

    const after = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().balance).toBe(before + 500); // moved once
  });

  it('lets exactly one of two racing debits succeed when only one can be afforded', async () => {
    const balance = (
      await app.inject({
        method: 'GET',
        url: `/wallets/${gamerProfileId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().balance as number;

    // seperate afforalbe debits
    const amount = Math.floor(balance * 0.6);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/wallets/${gamerProfileId}/debit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${gamerProfileId}/debit`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amount },
      }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const after = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().balance).toBe(balance - amount);
  });

  it('lists posted entries newest-first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wallets/${gamerProfileId}/entries`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const entries = res.json();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    const timestamps = entries.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((x, y) => y - x));
  });
});

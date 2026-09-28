import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('membership + subscription purchase (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let gamerProfileId: string;
  let gamerToken: string;
  let adminToken: string;
  let membershipPlanId: string;
  let subscriptionPlanId: string;

  const password = 'super-secret-1';
  const gamerUsername = `gamer-${randomUUID()}`;
  const adminUsername = `admin-${randomUUID()}`;
  const suffix = randomUUID().slice(0, 8);

  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = async () =>
    (await app.inject({ method: 'GET', url: `/wallets/${gamerProfileId}`, headers: as(adminToken) })).json()
      .balance as number;

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

    gamerToken = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { username: gamerUsername, password } })
    ).json().accessToken;
    adminToken = (
      await app.inject({ method: 'POST', url: '/auth/login', payload: { username: adminUsername, password } })
    ).json().accessToken;

    const gamerUser = await prisma.user.findUniqueOrThrow({
      where: { username: gamerUsername },
      include: { gamerProfile: true },
    });
    gamerProfileId = gamerUser.gamerProfile!.id;

    const membershipPlan = await app.inject({
      method: 'POST',
      url: '/membership-plans',
      headers: as(adminToken),
      payload: { name: `gold-${suffix}`, price: 10, durationDays: 30, discountPercent: 15 },
    });
    expect(membershipPlan.statusCode).toBe(201);
    membershipPlanId = membershipPlan.json().id;

    const subscriptionPlan = await app.inject({
      method: 'POST',
      url: '/subscription-plans',
      headers: as(adminToken),
      payload: { name: `nights-${suffix}`, price: 5, durationDays: 7, benefits: { windows: [] } },
    });
    expect(subscriptionPlan.statusCode).toBe(201);
    subscriptionPlanId = subscriptionPlan.json().id;

    await app.inject({
      method: 'POST',
      url: `/wallets/${gamerProfileId}/credit`,
      headers: as(adminToken),
      payload: { amount: 5000 },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { gamerProfileId } });
    await prisma.subscription.deleteMany({ where: { gamerProfileId } });
    await prisma.membershipPlan.deleteMany({ where: { id: membershipPlanId } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: subscriptionPlanId } });
    await prisma.user.deleteMany({ where: { username: { in: [gamerUsername, adminUsername] } } });
    await app.close();
  });

  it('buys a membership through the wallet service and replays the same key without a second charge', async () => {
    const purchase = () =>
      app.inject({
        method: 'POST',
        url: `/membership-plans/${membershipPlanId}/purchase`,
        headers: as(gamerToken),
        payload: { idempotencyKey: 'm-1' },
      });

    const first = await purchase();
    expect(first.statusCode).toBe(201);
    expect(await balance()).toBe(4000);

    const replay = await purchase();
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    expect(await balance()).toBe(4000);
  });

  it('rejects a second active membership with MEMBERSHIP_ALREADY_ACTIVE and no charge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/membership-plans/${membershipPlanId}/purchase`,
      headers: as(gamerToken),
      payload: { idempotencyKey: 'm-2' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'MEMBERSHIP_ALREADY_ACTIVE' });
    expect(await balance()).toBe(4000);
  });

  it('enforces one ACTIVE membership per gamer at the database level', async () => {
    const plan = await prisma.membershipPlan.findUniqueOrThrow({ where: { id: membershipPlanId } });
    await expect(
      prisma.membership.create({
        data: {
          gamerProfileId,
          membershipPlanId,
          discountPercentSnapshot: plan.discountPercent,
          startDate: new Date(),
          endDate: new Date(),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows several subscriptions for the same gamer', async () => {
    for (const key of ['s-1', 's-2']) {
      const res = await app.inject({
        method: 'POST',
        url: `/subscription-plans/${subscriptionPlanId}/purchase`,
        headers: as(gamerToken),
        payload: { idempotencyKey: key },
      });
      expect(res.statusCode).toBe(201);
    }
    expect(await balance()).toBe(3000);
  });

  it('returns INSUFFICIENT_FUNDS and creates nothing when the wallet cannot cover the price', async () => {
    await app.inject({
      method: 'POST',
      url: `/wallets/${gamerProfileId}/debit`,
      headers: as(adminToken),
      payload: { amount: 3000 },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/subscription-plans/${subscriptionPlanId}/purchase`,
      headers: as(gamerToken),
      payload: { idempotencyKey: 's-3' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await prisma.subscription.count({ where: { gamerProfileId } })).toBe(2);
  });
});

import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';

describe('machine enrollment (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let branchId: string;
  let otherBranchId: string;
  let managerToken: string;

  const password = 'super-secret-1';
  const managerUsername = `mgr-${randomUUID()}`;

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

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: managerUsername, password },
    });
    managerToken = login.json().accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.machine.deleteMany({ where: { branchId: { in: [branchId, otherBranchId] } } });
    await prisma.user.deleteMany({ where: { username: managerUsername } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    await app.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('blocks a manager from issuing a token for another branch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId: otherBranchId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an enrollment token that was never issued', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token: 'not-a-real-token-000000000000', serialNumber: `SN-${randomUUID()}`, agentPublicKey: 'pk' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('walks a station through issue -> redeem -> approve -> rotate -> revoke', async () => {
    const issue = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    expect(issue.statusCode).toBe(201);
    const { token } = issue.json();

    const serialNumber = `SN-${randomUUID()}`;
    const redeem = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token, serialNumber, agentPublicKey: 'test-public-key' },
    });
    expect(redeem.statusCode).toBe(201);
    const machine = redeem.json();
    expect(machine.enrollmentStatus).toBe('PENDING');

    // the same token can't be redeemed twice
    const replay = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token, serialNumber: `SN-${randomUUID()}`, agentPublicKey: 'test-public-key' },
    });
    expect(replay.statusCode).toBe(401);

    // a gamer/employee can't approve
    const gamerAttempt = await app.inject({
      method: 'POST',
      url: `/machines/${machine.id}/approve`,
      // no auth header at all -> unauthenticated
    });
    expect(gamerAttempt.statusCode).toBe(401);

    const approve = await app.inject({
      method: 'POST',
      url: `/machines/${machine.id}/approve`,
      headers: auth(managerToken),
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().enrollmentStatus).toBe('ENROLLED');

    const rotate = await app.inject({
      method: 'POST',
      url: `/machines/${machine.id}/rotate-token`,
      headers: auth(managerToken),
    });
    expect(rotate.statusCode).toBe(201);
    const { token: rotateToken } = rotate.json();

    // rotating with the wrong serial number is rejected
    const wrongSerial = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token: rotateToken, serialNumber: `SN-${randomUUID()}`, agentPublicKey: 'irrelevant' },
    });
    expect(wrongSerial.statusCode).toBe(409);

    // issue a fresh rotation token since the previous one got consumed by the failed attempt above
    const rotateAgain = await app.inject({
      method: 'POST',
      url: `/machines/${machine.id}/rotate-token`,
      headers: auth(managerToken),
    });
    const { token: rotateToken2 } = rotateAgain.json();

    const rotateRedeem = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token: rotateToken2, serialNumber, agentPublicKey: 'rotated-public-key' },
    });
    expect(rotateRedeem.statusCode).toBe(201);
    expect(rotateRedeem.json().agentPublicKey).toBe('rotated-public-key');
    expect(rotateRedeem.json().enrollmentStatus).toBe('ENROLLED');

    const get = await app.inject({
      method: 'GET',
      url: `/machines/${machine.id}`,
      headers: auth(managerToken),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().agentPublicKey).toBe('rotated-public-key');

    const revoke = await app.inject({
      method: 'POST',
      url: `/machines/${machine.id}/revoke`,
      headers: auth(managerToken),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().enrollmentStatus).toBe('DEACTIVATED');
  });

  it('rejects a fresh enrollment with a serial number that is already registered', async () => {
    const issue1 = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    const serialNumber = `SN-${randomUUID()}`;
    await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token: issue1.json().token, serialNumber, agentPublicKey: 'pk-1' },
    });

    const issue2 = await app.inject({
      method: 'POST',
      url: '/machines/enrollment-tokens',
      headers: auth(managerToken),
      payload: { branchId },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/machines/enroll',
      payload: { token: issue2.json().token, serialNumber, agentPublicKey: 'pk-2' },
    });
    expect(dupe.statusCode).toBe(409);
  });
});
